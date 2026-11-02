import { LINKEDIN_ORIGIN } from '../core/review';
import { redact } from '../core/privacy';

export interface PageDetailRequest { id: number; requestId: string; expectedOrigin: string }
export type PageDetailResponse =
  | { kind: 'response'; status: number; retryAfterMs: number | null; payload: unknown; started?: boolean }
  | { kind: 'error'; reason: 'origin' | 'duplicate' | 'network' | 'aborted' | 'json' | 'size' | 'permission' | 'execution'; message?: string; status?: number; retryAfterMs?: number | null; started?: boolean };
export type DetailTransport = (id: number, signal: AbortSignal, onStarted?: () => Promise<void>) => Promise<PageDetailResponse>;

export function detailExecutionError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Chrome scripting returned an unknown execution error.';
  return String(redact(message.replace(/https?:\/\/[^\s"'<>]+/g, '[URL omitted]').slice(0, 600)));
}

// Serialized by Chrome: keep this function self-contained and in the isolated world.
export async function fetchAnnotationDetailInPage(request: PageDetailRequest): Promise<PageDetailResponse> {
  if (location.origin !== request.expectedOrigin || !(location.pathname === '/ai-trainer' || location.pathname.startsWith('/ai-trainer/')) ||
    !Number.isSafeInteger(request.id) || request.id < 1) return { kind: 'error', reason: 'origin', message: 'The selected tab is not on https://www.linkedin.com/ai-trainer. Open the popup on the authorized AI Trainer tab again; no GET was issued.' };
  const scope = globalThis as typeof globalThis & { __aaDetailRequests?: Record<string, { id: number; controller: AbortController }>; __aaDetailCancelled?: Set<string> };
  if (scope.__aaDetailCancelled?.delete(request.requestId)) return { kind: 'error', reason: 'aborted' };
  const active = scope.__aaDetailRequests ??= {};
  if (Object.values(active).some(entry => entry.id === request.id)) return { kind: 'error', reason: 'duplicate', message: 'This annotation already has an in-flight request in the selected tab. No duplicate GET was issued.' };
  const controller = new AbortController();
  active[request.requestId] = { id: request.id, controller };
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    void chrome.runtime.sendMessage({ type: 'DETAIL_REQUEST_STARTED', requestId: request.requestId, annotationId: request.id })
      .catch(() => console.warn('DETAIL_REQUEST_DIAGNOSTIC_UNAVAILABLE'));
    const response = await fetch(`/ai-trainer/api/frontendAnnotationTaskResults/${request.id}`, {
      method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error',
      signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store',
    });
    const retry = response.headers.get('Retry-After');
    const seconds = retry === null ? NaN : Number(retry);
    const retryMs = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : NaN;
    const retryAfterMs = Number.isFinite(retryMs) ? Math.max(0, retryMs) : null;
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: 'response', status: response.status, retryAfterMs, payload: null, started: true };
    }
    if (Number(response.headers.get('Content-Length') ?? 0) > 10_000_000) {
      await response.body?.cancel(); return { kind: 'error', reason: 'size', status: response.status, started: true, message: 'HTTP response exceeded the 10 MB detail limit.' };
    }
    const reader = response.body?.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 10_000_000) { await reader.cancel(); return { kind: 'error', reason: 'size', status: response.status, started: true, message: 'HTTP response exceeded the 10 MB detail limit.' }; }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    } else text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { return { kind: 'error', reason: 'json', status: response.status, started: true, message: `HTTP ${response.status} returned non-JSON data (possibly a login page). No detail was saved.` }; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'error', reason: 'json', status: response.status, started: true, message: `HTTP ${response.status} did not return an annotation-detail object.` };
    const value = body as Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    for (const key of ['id', 'taskId', 'state', 'projectId', 'iterationId', 'pipelineId', 'pipelineStageId', 'createdAt', 'claimedAt', 'endedAt', 'durationInSeconds', 'idleDurationInSeconds']) {
      if (value[key] !== undefined) payload[key] = value[key];
    }
    for (const key of ['pipeline', 'pipelineStage']) {
      const item = value[key];
      if (item && typeof item === 'object' && !Array.isArray(item)) payload[key] = { id: (item as Record<string, unknown>).id };
    }
    const review = value.currentVersionReview;
    if (review && typeof review === 'object' && !Array.isArray(review)) {
      const fields = review as Record<string, unknown>;
      payload.currentVersionReview = { annotationScore: fields.annotationScore, status: fields.status, feedback: fields.feedback };
    } else if (review !== undefined) payload.currentVersionReview = review;
    return { kind: 'response', status: response.status, retryAfterMs, payload, started: true };
  } catch (error) {
    return { kind: 'error', reason: controller.signal.aborted ? 'aborted' : 'network', started: true,
      message: controller.signal.aborted ? 'AbortError: browser fetch cancelled or timed out after 30 seconds.' :
        `${error instanceof Error ? error.name : 'NetworkError'}: Failed to fetch in the selected tab. Inspect that tab's Console for network, CSP or redirect restrictions; no response body was stored.` };
  } finally { clearTimeout(timeout); delete active[request.requestId]; }
}
export function abortAnnotationDetailInPage(requestId: string): void {
  const scope = globalThis as typeof globalThis & { __aaDetailRequests?: Record<string, { controller: AbortController }>; __aaDetailCancelled?: Set<string> };
  const active = scope.__aaDetailRequests?.[requestId];
  if (active) { active.controller.abort(); return; }
  // Cancellation can reach the tab before Chrome starts the asynchronous fetch injection.
  const cancelled = scope.__aaDetailCancelled ??= new Set<string>();
  cancelled.add(requestId);
  if (cancelled.size > 1000) cancelled.delete(cancelled.values().next().value!);
}
export function sessionDetailTransport(tabId: number): DetailTransport {
  return async (id, signal, onStarted) => {
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    const abort = () => {
      void chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: abortAnnotationDetailInPage, args: [requestId] })
        .catch(() => console.warn('DETAIL_REQUEST_ABORT_UNAVAILABLE: tab closed, navigated or access revoked.'));
    };
    let startWork: Promise<{ error?: unknown }> = Promise.resolve({});
    let reportedStart = false;
    const reportStart = () => {
      if (reportedStart) return;
      reportedStart = true;
      startWork = Promise.resolve().then(() => onStarted?.()).then(() => ({}), error => ({ error }));
    };
    const listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => {
      if (sender.tab?.id !== tabId || sender.frameId !== 0 || !message || typeof message !== 'object') return;
      const event = message as Record<string, unknown>;
      if (event.type !== 'DETAIL_REQUEST_STARTED' || event.requestId !== requestId || event.annotationId !== id) return;
      reportStart(); respond({ ok: true });
    };
    chrome.runtime.onMessage.addListener(listener);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: fetchAnnotationDetailInPage,
        args: [{ id, requestId, expectedOrigin: LINKEDIN_ORIGIN }],
      });
      signal.throwIfAborted();
      const result = results[0]?.result;
      if (!result) throw new Error('The selected tab did not return a detail response. Use DevTools capture or import.');
      if (result.kind === 'response' || result.started) reportStart();
      const diagnostic = await startWork;
      if (diagnostic.error) throw diagnostic.error;
      return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const message = detailExecutionError(error);
      return { kind: 'error', reason: /permission|cannot access|host permission/i.test(message) ? 'permission' : 'execution',
        started: reportedStart, message: `${message} Open the popup on the authorized tab or explicitly grant LinkedIn collection access; DevTools/import remain available.` };
    } finally { signal.removeEventListener('abort', abort); chrome.runtime.onMessage.removeListener(listener); }
  };
}
