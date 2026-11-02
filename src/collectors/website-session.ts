import { z } from 'zod';
import { db } from '../core/storage';
import { annotationId, DETAIL_PATH, detailPayload, LINKEDIN_ORIGIN } from '../core/review';
import { detailExecutionError, type DetailTransport } from './detail-session';

const websiteTicketSchema = z.object({
  requestId: z.string().uuid(),
  annotationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestedAt: z.number().finite(),
  result: z.object({
    status: z.number().int().min(100).max(599).nullable(),
    retryAfterMs: z.number().finite().nonnegative().nullable(),
    started: z.boolean(),
    error: z.string().max(1000).optional(),
  }).optional(),
});
export type WebsiteDetailTicket = z.infer<typeof websiteTicketSchema>;
export type WebsiteDetailResult = NonNullable<WebsiteDetailTicket['result']>;
export const websiteDetailKey = (tabId: number) => `website-detail:${tabId}`;

export function matchingWebsiteTicket(value: unknown, url: string, method: string, startedAt: string): WebsiteDetailTicket | null {
  const parsed = websiteTicketSchema.safeParse(value);
  if (!parsed.success || parsed.data.result || method !== 'GET' || !(Date.parse(startedAt) >= parsed.data.requestedAt)) return null;
  try {
    const endpoint = new URL(url);
    return endpoint.origin === LINKEDIN_ORIGIN && endpoint.pathname === `${DETAIL_PATH}${parsed.data.annotationId}` ? parsed.data : null;
  } catch { return null; }
}

// Serialized by Chrome; click only an existing same-tab annotation link, never a submission control.
export function openAnnotationThroughWebsite(id: number): 'clicked' | 'navigate' | 'reload' {
  if (location.origin !== 'https://www.linkedin.com' || !(location.pathname === '/ai-trainer' || location.pathname.startsWith('/ai-trainer/')) ||
    !Number.isSafeInteger(id) || id < 1) throw new Error('Open the authorized LinkedIn AI Trainer tab before website collection.');
  const path = `/ai-trainer/tasks/${id}`;
  if (location.pathname === path) return 'reload';
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let url: URL;
    try { url = new URL(link.href, location.href); } catch { continue; }
    if (url.origin === location.origin && url.pathname === path && !link.download && (!link.target || link.target === '_self') &&
      link.getAttribute('aria-disabled') !== 'true' && link.getClientRects().length > 0) {
      link.click(); return 'clicked';
    }
  }
  return 'navigate';
}

function waitForWebsiteResult(tabId: number, ticket: WebsiteDetailTicket, signal: AbortSignal) {
  let stop = () => {};
  const promise = new Promise<WebsiteDetailResult>(resolve => {
    let settled = false;
    const finish = (result: WebsiteDetailResult) => {
      if (settled) return;
      settled = true; stop(); resolve(result);
    };
    const unavailable = (error: string) => finish({ status: null, retryAfterMs: null, started: false, error });
    const abort = () => unavailable('Website collection stopped. No further task will be opened.');
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      if (changes[`devtools:${tabId}`] && changes[`devtools:${tabId}`]?.newValue !== true) {
        unavailable('Website DevTools closed. Reopen DevTools on the selected tab before resuming.'); return;
      }
      if (changes[`capture:${tabId}`] && changes[`capture:${tabId}`]?.newValue !== true) {
        unavailable('Network capture stopped. Re-arm capture before resuming.'); return;
      }
      const parsed = websiteTicketSchema.safeParse(changes[websiteDetailKey(tabId)]?.newValue);
      if (parsed.success && parsed.data.requestId === ticket.requestId && parsed.data.result) finish(parsed.data.result);
    };
    const removed = (id: number) => { if (id === tabId) unavailable('Selected website tab closed. Open the authorized tab before resuming.'); };
    const navigated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId || !change.url) return;
      const url = new URL(change.url);
      if (url.origin !== LINKEDIN_ORIGIN || !(url.pathname === '/ai-trainer' || url.pathname.startsWith('/ai-trainer/'))) {
        unavailable('The website left AI Trainer, possibly for login or an access check. Complete it normally before resuming.');
      }
    };
    const timer = setTimeout(() => unavailable('No matching website detail response was captured within 60 seconds. Keep DevTools open; check that the task loads normally. No automatic retry was made.'), 60_000);
    stop = () => {
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(changed);
      chrome.tabs.onRemoved.removeListener(removed);
      chrome.tabs.onUpdated.removeListener(navigated);
      signal.removeEventListener('abort', abort);
    };
    chrome.storage.onChanged.addListener(changed);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.onUpdated.addListener(navigated);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  return { promise, stop };
}

export function websiteDetailTransport(tabId: number): DetailTransport {
  return async (id, signal, onStarted) => {
    signal.throwIfAborted();
    annotationId(String(id));
    const flags = await chrome.storage.session.get(`devtools:${tabId}`);
    if (flags[`devtools:${tabId}`] !== true) return { kind: 'error', reason: 'execution', message: 'Open Chrome DevTools on the selected LinkedIn tab before Collect through website. This method needs DevTools to capture the website response; no task was opened.' };
    const record = await db.records.get(JSON.stringify([LINKEDIN_ORIGIN, null, String(id)]));
    if (!record) return { kind: 'error', reason: 'execution', message: 'Annotation is not in the discovered LinkedIn listing. No task was opened.' };
    const ticket: WebsiteDetailTicket = { requestId: crypto.randomUUID(), annotationId: id, requestedAt: Date.now() };
    const key = websiteDetailKey(tabId);
    const waiting = waitForWebsiteResult(tabId, ticket, signal);
    try {
      await chrome.storage.session.set({ [`capture:${tabId}`]: true, [key]: ticket });
      signal.throwIfAborted();
      const [opened] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: openAnnotationThroughWebsite, args: [id] });
      signal.throwIfAborted();
      if (opened?.result === 'navigate') await chrome.tabs.update(tabId, { url: `${LINKEDIN_ORIGIN}/ai-trainer/tasks/${id}` });
      else if (opened?.result === 'reload') await chrome.tabs.reload(tabId);
      else if (opened?.result !== 'clicked') throw new Error('The website did not confirm a task click. No second navigation was attempted.');
      const result = await waiting.promise;
      signal.throwIfAborted();
      if (result.started) await onStarted?.();
      if (result.error || result.status === null) return { kind: 'error', reason: 'execution', started: result.started, retryAfterMs: result.retryAfterMs,
        ...(result.status === null ? {} : { status: result.status }), message: result.error ?? 'No website HTTP response was received.' };
      if (result.status >= 300 && result.status < 400) return { kind: 'error', reason: 'execution', status: result.status, retryAfterMs: result.retryAfterMs, started: true,
        message: 'The website detail request redirected. Check normal website access before resuming; collection will not navigate to another task.' };
      if (result.status < 200 || result.status >= 300) return { kind: 'response', status: result.status, retryAfterMs: result.retryAfterMs, payload: null, started: true };
      const saved = await db.records.get(record.key);
      const fetchedAt = Date.parse(saved?.detail?.fetchedAt ?? '');
      if (!saved?.detail?.verified || saved.detail.via !== 'devtools' || !saved.detail.data ||
        !Number.isFinite(fetchedAt) || fetchedAt < ticket.requestedAt) {
        return { kind: 'error', reason: 'execution', status: result.status, started: true, message: 'The website response did not produce a verified saved detail. Collection paused instead of reusing stale data.' };
      }
      return { kind: 'response', status: result.status, retryAfterMs: result.retryAfterMs, payload: detailPayload(saved.detail.data), started: true };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return { kind: 'error', reason: 'execution', message: `${detailExecutionError(error)} Website navigation failed. Reopen the popup on the authorized tab; no direct API request or credential workaround was attempted.` };
    } finally {
      waiting.stop();
      const stored = await chrome.storage.session.get(key);
      const current = websiteTicketSchema.safeParse(stored[key]);
      if (current.success && current.data.requestId === ticket.requestId) await chrome.storage.session.remove(key);
    }
  };
}
