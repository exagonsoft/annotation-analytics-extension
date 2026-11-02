import { db } from '../core/storage';
import { annotationId, defaultReviewConfig, DETAIL_PATH, LINKEDIN_ORIGIN, mergeReviewRecord, parseAnnotationDetail, reviewCollectorConfigSchema, shouldSkipCachedDetail, type DetailCollection, type DetailDiagnosticEvent, type ReviewCollectionMethod, type ReviewCollectorConfig, type ReviewDiagnostics, type ReviewRun } from '../core/review';
import { wait } from './api';
import { detailExecutionError, type DetailTransport } from './detail-session';

export interface DetailCollectorDependencies {
  transport: DetailTransport;
  exclusive?: (work: () => Promise<ReviewRun>) => Promise<ReviewRun>;
  onProgress?: (run: ReviewRun) => void | Promise<void>;
  executionContext?: string;
  method?: ReviewCollectionMethod;
  jobId?: string;
  runnerTabId?: number;
}
export function reviewEligible(sourceUrl: string, id: string): boolean {
  try { return new URL(sourceUrl).origin === LINKEDIN_ORIGIN && annotationId(id) > 0; } catch { return false; }
}
async function exclusiveCollection(work: () => Promise<ReviewRun>): Promise<ReviewRun> {
  if (!navigator.locks) throw new Error('This Chrome context does not support the collection lock. Use DevTools capture or import.');
  return navigator.locks.request('annotation-analytics:linkedin-review-details', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another review collector is already active. Pause or cancel it before starting another.');
    return work();
  });
}
export class AnnotationDetailCollector {
  private controller: AbortController | null = null;
  private intent: 'paused' | 'cancelled' = 'cancelled';
  private active = false;
  private run: ReviewRun | null = null;
  private nextStart = 0;
  constructor(private dependencies: DetailCollectorDependencies) {}
  pause() { this.intent = 'paused'; this.controller?.abort(); }
  cancel() { this.intent = 'cancelled'; this.controller?.abort(); }
  async start(options: { config?: ReviewCollectorConfig; refresh?: boolean; resume?: ReviewRun; annotationIds?: string[] } = {}): Promise<ReviewRun> {
    if (this.active) throw new Error('This collector is already running.');
    this.active = true; this.controller = new AbortController(); this.intent = 'cancelled';
    try { return await (this.dependencies.exclusive ?? exclusiveCollection)(() => this.collect(options)); }
    finally { this.active = false; this.controller = null; }
  }
  private async progress() {
    if (!this.run) return;
    this.run.updatedAt = new Date().toISOString();
    await db.reviewRuns.put({ ...this.run });
    await this.dependencies.onProgress?.({ ...this.run });
  }
  private async collect(options: { config?: ReviewCollectorConfig; refresh?: boolean; resume?: ReviewRun; annotationIds?: string[] }): Promise<ReviewRun> {
    const method = options.resume?.method ?? this.dependencies.method ?? 'session';
    if (method !== (this.dependencies.method ?? 'session')) throw new Error('Resume must use the saved collection method.');
    const requestedConfig = options.resume?.config ?? options.config ?? defaultReviewConfig;
    const config = method === 'website' ? { ...requestedConfig, concurrency: 1, maxRetries: 0, delayMs: Math.max(1500, requestedConfig.delayMs) } : requestedConfig;
    if (!reviewCollectorConfigSchema.safeParse(config).success) throw new Error('Use concurrency 1–3, pacing 500–30000 ms and retries 0–3.');
    if (options.resume?.notBefore && Date.now() < options.resume.notBefore) throw new Error(`Retry-After is still active. Resume after ${new Date(options.resume.notBefore).toLocaleString()}.`);
    const cooldown = await db.reviewRuns.filter(run => run.notBefore !== null && run.notBefore > Date.now()).first();
    if (cooldown?.notBefore) throw new Error(`Server Retry-After is still active. Resume after ${new Date(cooldown.notBefore).toLocaleString()}.`);
    const queue: { id: string; key: string }[] = [];
    const seen = new Set<string>(), discovered = new Set<string>();
    const previousIds = options.resume ? new Set(options.resume.annotationIds) : options.annotationIds ? new Set(options.annotationIds.map(id => String(annotationId(id)))) : null;
    const refresh = options.resume?.refresh ?? !!options.refresh;
    let skippedCache = 0, selected = 0;
    await db.records.toCollection().each(record => {
      const id = String(record.id);
      discovered.add(id);
      if (!reviewEligible(record.source.url, id) || seen.has(id)) return;
      seen.add(id);
      if (previousIds && !previousIds.has(id)) return;
      selected++;
      if (shouldSkipCachedDetail(record, refresh, options.resume?.id)) { skippedCache++; return; }
      queue.push({ id, key: record.key });
    });
    await db.reviewRuns.where('status').equals('running').modify({ status: 'interrupted', message: 'Previous collection context closed. Saved details remain available.' });
    const now = new Date().toISOString();
    const diagnostics: ReviewDiagnostics = {
      dispatched: 0, started: 0, completed: 0, failed: 0, httpCodes: {}, latestEndpoint: null, latestError: null, events: [],
      ...options.resume?.diagnostics,
      discovered: discovered.size, eligible: seen.size, skippedCache, queued: queue.length,
      executionContext: this.dependencies.executionContext ?? 'chrome.scripting ISOLATED world in selected LinkedIn AI Trainer tab; relative same-origin session GET',
    };
    this.run = options.resume ? { ...options.resume, method, config, failed: 0, diagnostics, status: 'running', notBefore: null, message: '' } : {
      id: crypto.randomUUID(), status: 'running', startedAt: now, updatedAt: now, config,
      annotationIds: queue.map(item => item.id), refresh, completed: 0, failed: 0, requests: 0, message: '', notBefore: null,
      diagnostics, method,
    };
    this.run.jobId = this.dependencies.jobId;
    this.run.runnerTabId = this.dependencies.runnerTabId;
    this.nextStart = 0;
    const signal = this.controller!.signal;
    await this.progress();
    if (!seen.size || previousIds && !selected) {
      this.run.status = 'paused';
      this.run.message = previousIds && !selected ? 'Selected annotation ID was not found in the discovered LinkedIn listing. Collect that annotation first; IDs are never enumerated.' :
        `Found ${discovered.size} annotation IDs, but none are eligible LinkedIn IDs. Collect the authorized paginated listing in Sources, or import it with its original LinkedIn response URL.`;
      diagnostics.latestError = this.run.message;
      await this.progress();
      throw new Error(this.run.message);
    }
    let index = 0;
    const worker = async () => {
      while (!signal.aborted && index < queue.length) {
        const item = queue[index++]!;
        const record = await db.records.get(item.key);
        if (record && shouldSkipCachedDetail(record, refresh, this.run!.id)) { await this.cacheHit(); continue; }
        const dispatched = diagnostics.dispatched;
        await this.process(item, config, signal);
        if (method === 'website' && diagnostics.dispatched > dispatched) this.nextStart = Date.now() + config.delayMs;
      }
    };
    const results = await Promise.allSettled(Array.from({ length: config.concurrency }, async () => {
      try { await worker(); } catch (error) { this.controller!.abort(); throw error; }
    }));
    if (results.some(result => result.status === 'rejected')) {
      this.controller!.abort(); this.run.status = 'paused';
      this.run.message = 'Collection storage or execution failed. Saved details are retained; check local storage and resume manually.';
      diagnostics.latestError = this.run.message;
    }
    if (this.run.status === 'running') {
      this.run.status = signal.aborted ? this.intent : this.run.failed ? 'partial' : 'complete';
      this.run.message = signal.aborted ? 'Stopped by user. Saved details are retained; Resume continues the remaining IDs.' :
        !queue.length ? `No requests queued: ${skippedCache} verified details skipped from cache. Use Refresh Existing Reviews or Force Refresh Selected Reviews to request them again.` :
        this.run.failed ? 'Queue finished with failed requests. Results are partial; inspect diagnostics and resume explicitly.' : 'Queue finished. Review loaded details and listing completeness separately.';
    }
    await this.progress();
    return this.run;
  }
  private event(item: { id: string }, type: DetailDiagnosticEvent['type'], status: number | null = null, error?: string) {
    const diagnostics = this.run!.diagnostics!;
    const path = `${DETAIL_PATH}${item.id}`;
    diagnostics.latestEndpoint = path;
    if (error) diagnostics.latestError = error;
    diagnostics.events = [...diagnostics.events.slice(-199), { at: new Date().toISOString(), type, annotationId: item.id, path, status, ...(error ? { error } : {}) }];
    console.info(`${type} annotationId=${item.id}${status === null ? '' : ` status=${status}`}`);
  }
  private async cacheHit() {
    this.run!.diagnostics!.skippedCache++;
    await this.progress();
  }
  private async entry(key: string, update: (entry: DetailCollection) => DetailCollection, skipCached = false): Promise<boolean> {
    return db.transaction('rw', db.records, async () => {
      const record = await db.records.get(key);
      if (!record) throw new Error('Annotation removed during collection.');
      if (skipCached && shouldSkipCachedDetail(record, this.run!.refresh, this.run!.id)) return false;
      const previous = record.detail ?? { status: 'pending', data: null, attempts: 0, errors: [], fetchedAt: null, lastAttemptAt: null, via: 'session' };
      await db.records.put(mergeReviewRecord(record, update(previous)));
      return true;
    });
  }
  private async pace(config: ReviewCollectorConfig, signal: AbortSignal) {
    const now = Date.now(), start = Math.max(now, this.nextStart);
    this.nextStart = start + config.delayMs;
    await wait(Math.max(0, start - now), signal);
  }
  private async process(item: { id: string; key: string }, config: ReviewCollectorConfig, signal: AbortSignal) {
    try {
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        await this.pace(config, signal);
        signal.throwIfAborted();
        const claimed = await this.entry(item.key, entry => ({ ...entry, status: 'fetching', attempts: entry.attempts + 1, lastAttemptAt: new Date().toISOString(),
          attemptRunId: this.run!.id, via: this.run!.method === 'website' ? 'devtools' : 'session' }), true);
        if (!claimed) { await this.cacheHit(); return; }
        const diagnostics = this.run!.diagnostics!;
        diagnostics.dispatched++;
        this.event(item, 'DETAIL_REQUEST_DISPATCHED');
        await this.progress();
        let started = false;
        const onStarted = async () => {
          if (started) return;
          started = true; diagnostics.started++;
          this.event(item, 'DETAIL_REQUEST_STARTED');
          await this.progress();
        };
        let response;
        try { response = await this.dependencies.transport(annotationId(item.id), signal, onStarted); }
        catch (error) {
          signal.throwIfAborted();
          const message = detailExecutionError(error);
          diagnostics.failed++; this.event(item, 'DETAIL_REQUEST_FAILED', null, message);
          await this.fail(item.key, null, message);
          this.intent = 'paused'; this.run!.status = 'paused'; this.run!.message = `Collection paused: ${message} Reopen the popup on LinkedIn or use DevTools/import. No credential workaround is supported.`;
          this.controller!.abort(); return;
        }
        signal.throwIfAborted();
        if (response.kind === 'response' || response.started) {
          await onStarted();
          diagnostics.completed++;
        }
        const httpStatus = response.kind === 'response' ? response.status : response.status ?? null;
        if (httpStatus !== null) diagnostics.httpCodes[String(httpStatus)] = (diagnostics.httpCodes[String(httpStatus)] ?? 0) + 1;
        this.run!.requests++;
        if (response.kind === 'response' && response.status >= 200 && response.status < 300) {
          let data;
          try {
            data = parseAnnotationDetail(response.payload, item.id);
          } catch {
            diagnostics.failed++; this.event(item, 'DETAIL_REQUEST_FAILED', response.status, 'Invalid detail JSON or mismatched annotation ID.');
            await this.fail(item.key, response.status, 'Invalid detail JSON or mismatched annotation ID. No response data was merged.'); return;
          }
          await this.entry(item.key, entry => ({ ...entry, status: 'complete', verified: true, data, fetchedAt: new Date().toISOString(), completedRunId: this.run!.id, attemptRunId: undefined }));
          this.run!.completed++;
          this.event(item, 'DETAIL_REQUEST_SUCCESS', response.status);
          await this.progress(); return;
        }
        const status = httpStatus;
        const retryAfter = response.retryAfterMs ?? null;
        const restricted = status === 401 || status === 403 || status === 429;
        const transient = response.kind === 'error' ? ['network', 'aborted'].includes(response.reason) : [500, 502, 503, 504].includes(response.status);
        const message = status === 401 ? 'HTTP 401: the server did not accept authentication for this request. Sign in through the website normally; resume manually only after access is restored. DevTools capture/import remain available.' :
          status === 403 ? this.run!.method === 'website' ?
            "HTTP 403: the website's own request was refused. Keep this queue paused and check access through the normal website. No automatic retry or alternative request context will be used; saved reviews are retained." :
            "HTTP 403: the server refused this request. A working website session does not guarantee collector access; site-managed CSRF or other platform checks may differ. The exact reason is unknown. If the review opens normally, keep this queue paused and use Sources > Start capture with the website's DevTools open, then reopen the review. Do not copy credential or CSRF headers." :
          status === 429 ? 'HTTP 429: the server rate-limited this request. Keep the queue paused until the displayed cooldown and any Retry-After have elapsed; resume manually. DevTools capture/import remain available.' :
          response.kind === 'error' ? response.message ?? `Detail request unavailable (${response.reason}).` : `HTTP ${status} detail request failed.`;
        diagnostics.failed++; this.event(item, 'DETAIL_REQUEST_FAILED', status, message);
        await this.fail(item.key, status, message, transient && attempt < config.maxRetries && !restricted);
        if (restricted || retryAfter !== null && retryAfter > 30_000 || response.kind === 'error' && ['origin', 'duplicate', 'permission', 'execution'].includes(response.reason)) {
          this.run!.status = 'paused'; this.intent = 'paused';
          this.run!.notBefore = status === 429 ? Date.now() + Math.max(60_000, retryAfter ?? 0) : retryAfter !== null ? Date.now() + retryAfter : null;
          this.run!.message = restricted ? `Paused: ${message}` :
            `Paused: ${message} Use the selected tab's Console/Network diagnostics or DevTools capture/import.`;
          this.controller!.abort(); await this.progress(); return;
        }
        if (!transient || attempt >= config.maxRetries) return;
        await wait(Math.max(retryAfter ?? 0, 1000 * 2 ** attempt), signal);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      await this.entry(item.key, entry => entry.status === 'fetching' ? { ...entry, status: entry.data ? 'complete' : 'pending' } : entry);
    }
  }
  private async fail(key: string, status: number | null, message: string, retrying = false) {
    await this.entry(key, entry => ({
      ...entry, status: retrying ? 'pending' : 'failed',
      errors: [...entry.errors.slice(-19), { at: new Date().toISOString(), status, message }],
    }));
    if (!retrying) this.run!.failed++;
    await this.progress();
  }
}
