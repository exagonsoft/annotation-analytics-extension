import type { Mappings, Source } from '../core/model';
import { discover, normalize, object, pathValue } from '../core/parsing';
import { endpointUrl, safeUrl } from '../core/privacy';
import { db, ingest, newSource } from '../core/storage';
import { DETAIL_PATH, LINKEDIN_ORIGIN } from '../core/review';
import { joinRelated, type ResultJoin } from './related';

export interface NextPage { url: string | null; terminal: boolean; strategy: string }
export function pagination(payload: unknown, currentUrl: string, length: number): NextPage {
  const current = endpointUrl(currentUrl);
  const arrayPath = discover(payload).arrayPath;
  const container = arrayPath.includes('.') ? pathValue(payload, arrayPath.split('.').slice(0, -1).join('.')) : payload;
  const candidates = [pathValue(container, 'pagination'), container, pathValue(payload, 'pagination'), pathValue(payload, 'meta.pagination'), pathValue(payload, 'meta'), pathValue(payload, 'data.pagination'), pathValue(payload, 'data'), payload].map(object).filter(o => !!o);
  for (const meta of candidates) {
    const links = object(meta.links);
    const next = Object.hasOwn(meta, 'next') ? meta.next : Object.hasOwn(meta, 'nextUrl') ? meta.nextUrl : links?.next;
    if (typeof next === 'string' && next.trim()) {
      const nextUrl = endpointUrl(new URL(next, current).href);
      if (nextUrl.origin !== current.origin) throw new Error('Cross-origin pagination refused. Configure that endpoint separately.');
      for (const [key, value] of current.searchParams) if (!nextUrl.searchParams.has(key)) nextUrl.searchParams.set(key, value);
      return { url: nextUrl.href, terminal: false, strategy: 'next link' };
    }
    if (next === null && ('next' in meta || 'nextUrl' in meta || !!links && 'next' in links)) return { url: null, terminal: true, strategy: 'next link' };
    const pageInfo = object(meta.pageInfo) ?? meta;
    if (pageInfo.hasNextPage === false || meta.hasMore === false) return { url: null, terminal: true, strategy: 'explicit end' };
    const cursor = pageInfo.endCursor ?? meta.nextCursor;
    if (typeof cursor === 'string' && cursor && (pageInfo.hasNextPage === true || 'nextCursor' in meta)) {
      const param = current.searchParams.has('after') ? 'after' : 'cursor';
      current.searchParams.set(param, cursor);
      return { url: current.href, terminal: false, strategy: `cursor (${param})` };
    }
    if ('nextCursor' in meta && meta.nextCursor === null) return { url: null, terminal: true, strategy: 'cursor' };
    const page = meta.page ?? meta.currentPage;
    const pages = meta.totalPages ?? meta.pageCount;
    if (typeof page === 'number' && typeof pages === 'number' && current.searchParams.has('page')) {
      if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pages) || page < 1 || pages < 1) throw new Error('Invalid page-number metadata.');
      if (page >= pages) return { url: null, terminal: true, strategy: 'page' };
      current.searchParams.set('page', String(page + 1));
      return { url: current.href, terminal: false, strategy: 'page' };
    }
    const offset = meta.offset;
    const limit = meta.limit;
    const total = meta.total ?? meta.totalCount;
    if (typeof offset === 'number' && typeof limit === 'number' && typeof total === 'number' && current.searchParams.has('offset')) {
      if (![offset, limit, total].every(Number.isSafeInteger) || offset < 0 || limit <= 0 || total < 0) throw new Error('Invalid offset metadata.');
      if (offset + length >= total) return { url: null, terminal: true, strategy: 'offset' };
      if (!length) throw new Error('Empty page before the reported total.');
      current.searchParams.set('offset', String(offset + limit));
      return { url: current.href, terminal: false, strategy: 'offset' };
    }
  }
  return { url: null, terminal: false, strategy: 'undetected' };
}
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function requestJson(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch, onResponse?: (status: number) => void): Promise<unknown> {
  const target = new URL(url);
  if (target.origin === LINKEDIN_ORIGIN && target.pathname.startsWith(DETAIL_PATH)) throw new Error('Use Fetch Review Scores for this endpoint. LinkedIn detail requests must run in the authorized same-origin website tab.');
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const response = await fetcher(url, { credentials: 'include', signal, redirect: 'error', headers: { Accept: 'application/json' }, cache: 'no-store' });
    onResponse?.(response.status);
    if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
      const retryHeader = response.headers.get('Retry-After');
      const seconds = retryHeader ? Number(retryHeader) : NaN;
      const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : retryHeader && Number.isFinite(Date.parse(retryHeader)) ? Date.parse(retryHeader) - Date.now() : 1000 * 2 ** attempt;
      await response.body?.cancel();
      if (requestedDelay > 30_000) throw new Error('Server requested a retry delay longer than 30 seconds. Wait before collecting again.');
      const delay = Math.max(500, requestedDelay);
      await wait(delay, signal);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}. Check endpoint access in your authorized session; use DevTools capture or import if session access is restricted.`);
    }
    const length = Number(response.headers.get('Content-Length') ?? 0);
    if (length > 20_000_000) { await response.body?.cancel(); throw new Error('Response exceeds the 20 MB page limit.'); }
    let body = '';
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 20_000_000) { await reader.cancel(); throw new Error('Response exceeds the 20 MB page limit.'); }
          body += decoder.decode(part.value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
    } else body = await response.text();
    try { return JSON.parse(body) as unknown; } catch { throw new Error('Endpoint did not return valid JSON. It may have returned a login page.'); }
  }
  throw new Error('Retry limit reached.');
}
export interface CollectOptions {
  endpoint: string; mappings: Mappings; maxPages: number; delayMs: number; signal: AbortSignal;
  onProgress?: (source: Source) => void; fetcher?: typeof fetch;
  join?: ResultJoin;
}
export async function collectApi(options: CollectOptions): Promise<Source> {
  const first = endpointUrl(options.endpoint);
  const source = newSource('api', safeUrl(first.href));
  const visited = new Set<string>();
  const unique = new Set<string>();
  let url: string | null = first.href;
  const limit = Math.min(1000, Math.max(1, options.maxPages));
  await db.sources.put(source);
  try {
    while (url && source.pages < limit) {
      options.signal.throwIfAborted();
      if (visited.has(url)) throw new Error('Pagination loop detected; retained all completed pages.');
      visited.add(url);
      const payload = await requestJson(url, options.signal, options.fetcher, status => { source.requests++; source.status = status; });
      options.signal.throwIfAborted();
      const envelope = discover(payload);
      const relatedItems = options.join ? pathValue(payload, options.join.arrayPath) : null;
      if (options.join && !Array.isArray(relatedItems)) throw new Error('Related-result array path did not resolve to an array. Inspect the response and configure the exact path.');
      const items = Array.isArray(relatedItems) ? relatedItems : envelope.records;
      if (!options.join && source.pages === 0 && !items.length && envelope.total !== 0) throw new Error('No supported annotation records found. Inspect a real task-list response in DevTools.');
      source.reportedTotal = envelope.total ?? source.reportedTotal;
      source.httpMethod = 'GET'; source.status = 200;
      for (const raw of items) {
        if (options.join) {
          const id = pathValue(raw, options.join.resultIdPath);
          if (typeof id === 'string' || typeof id === 'number') unique.add(String(id));
        } else {
          const record = normalize(raw, source, options.mappings);
          if (record) unique.add(record.key);
        }
      }
      if (options.join) await joinRelated(items, source, options.mappings, options.join);
      else await ingest(items, source, options.mappings);
      source.uniqueRecords = unique.size;
      const next = pagination(payload, url, items.length);
      const completeCount = !options.join && source.reportedTotal !== null && unique.size >= source.reportedTotal;
      if (next.terminal || completeCount) {
        source.completeness = !options.join && source.reportedTotal !== null && unique.size < source.reportedTotal ? 'partial' : 'complete';
        url = null;
      } else {
        url = next.url;
        if (!url) source.diagnostics.push('Pagination not detected. Loaded records are not a verified global total.');
      }
      options.onProgress?.({ ...source });
      if (url) await wait(Math.max(100, options.delayMs), options.signal);
    }
    if (url) source.diagnostics.push(`Stopped at the ${limit}-page safety limit.`);
  } catch (error) {
    if (options.signal.aborted) {
      source.diagnostics.push('Collection cancelled. Completed pages retained.');
    } else {
      source.errors++;
      source.completeness = source.pages ? 'partial' : 'failed';
      source.diagnostics.push(error instanceof Error ? error.message : 'Collection failed.');
    }
  }
  await db.sources.put(source);
  options.onProgress?.({ ...source });
  return source;
}
