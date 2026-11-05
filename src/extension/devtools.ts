import { discover } from '../core/parsing';
import { safeUrl } from '../core/privacy';
import { db, getSettings, ingest, newSource } from '../core/storage';
import { parseAnnotationDetail } from '../core/review';
import { matchingWebsiteTicket, websiteDetailKey, type WebsiteDetailResult } from '../collectors/website-session';
import { financialEndpoint } from '../core/finance';
import { ingestFinancialTime } from '../core/finance-storage';
import { greenlightCaptureKey, type GreenlightCaptureState } from '../collectors/greenlight';

const tabId = chrome.devtools.inspectedWindow.tabId;
chrome.devtools.panels.create('Annotation Analytics', 'icons/icon32.png', 'panel.html', () => {
  if (chrome.runtime.lastError) { console.error('Annotation Analytics panel registration failed. Reopen DevTools.'); return; }
  void chrome.storage.session.set({ [`devtools:${tabId}`]: true });
});
const captureKey = `capture:${tabId}`;
let chain = Promise.resolve();
chrome.devtools.network.onRequestFinished.addListener(request => {
  // Capture is explicitly enabled per inspected tab; DevTools must remain open.
  chain = chain.then(async () => {
    const financeKey = greenlightCaptureKey(tabId);
    const finance = (await chrome.storage.session.get(financeKey))[financeKey] as GreenlightCaptureState | undefined;
    const endpoint = financialEndpoint(request.request.url);
    if (finance?.enabled && endpoint && request.request.method === 'GET') {
      const status = request.response.status >= 100 ? request.response.status : null;
      try {
        if (!status || status < 200 || status >= 300) throw new Error(`Greenlight native request returned ${status === null ? 'no HTTP response' : `HTTP ${status}`}. Check authorized access before resuming.`);
        if (!/json/i.test(request.response.content.mimeType ?? '')) throw new Error('Greenlight native response is not JSON.');
        if (request.response.content.size > 20_000_000) throw new Error('Financial response exceeds the 20 MB capture limit.');
        const payload = await new Promise<unknown>((resolve, reject) => request.getContent((content, encoding) => {
          try {
            if (!content) throw new Error('Financial response body unavailable. Reload Greenlight with DevTools open.');
            const text = encoding === 'base64' ? new TextDecoder().decode(Uint8Array.from(atob(content), c => c.charCodeAt(0))) : content;
            if (text.length > 20_000_000) throw new Error('Financial response exceeds the 20 MB capture limit.');
            resolve(JSON.parse(text));
          } catch (error) { reject(error instanceof SyntaxError ? new Error('Malformed Greenlight financial JSON.') : error); }
        }));
        await ingestFinancialTime(payload, request.request.url);
        const current = (await chrome.storage.session.get(financeKey))[financeKey] as GreenlightCaptureState | undefined;
        if (!current) return;
        await chrome.storage.session.set({ [financeKey]: { ...current, received: current.received + 1, capturedAt: new Date().toISOString(),
          start: endpoint.start, end: endpoint.end, status, error: null } satisfies GreenlightCaptureState });
      } catch (error) {
        await chrome.storage.session.set({ [financeKey]: { ...finance, enabled: false, capturedAt: new Date().toISOString(), status,
          error: error instanceof Error ? error.message : 'Financial capture failed; saved results remain.' } satisfies GreenlightCaptureState });
      }
      return;
    }
    const key = websiteDetailKey(tabId);
    const flags = await chrome.storage.session.get([captureKey, key]);
    if (flags[captureKey] !== true) return;
    const ticket = matchingWebsiteTicket(flags[key], request.request.url, request.request.method, request.startedDateTime);
    const finish = async (result: WebsiteDetailResult) => {
      if (!ticket) return;
      const current = await chrome.storage.session.get(key);
      if (matchingWebsiteTicket(current[key], request.request.url, request.request.method, request.startedDateTime)?.requestId === ticket.requestId) {
        await chrome.storage.session.set({ [key]: { ...ticket, result } });
      }
    };
    const mime = request.response.content.mimeType ?? '';
    const status = request.response.status >= 100 ? request.response.status : null;
    const retry = ticket ? request.response.headers.find(header => header.name.toLowerCase() === 'retry-after')?.value : undefined;
    const seconds = retry === undefined ? NaN : Number(retry);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : NaN;
    const retryAfterMs = Number.isFinite(delay) ? Math.max(0, delay) : null;
    const result: WebsiteDetailResult = { status, retryAfterMs, started: true };
    if (status === null || status < 200 || status >= 300) {
      await finish({ ...result, ...(status === null ? { error: 'The website request did not receive an HTTP response.' } : {}) });
      return;
    }
    if (!/json/i.test(mime)) {
      await finish({ ...result, error: 'The website returned non-JSON data for the annotation detail. Open the task normally and check access before resuming.' }); return;
    }
    const source = newSource('devtools', safeUrl(request.request.url));
    source.httpMethod = request.request.method; source.status = request.response.status;
    source.requests = 1;
    if (request.response.content.size > 20_000_000) {
      source.errors = 1; source.completeness = 'failed'; source.diagnostics.push('Skipped response larger than 20 MB.'); await db.sources.put(source);
      await finish({ ...result, error: 'The website response exceeded the capture size limit.' }); return;
    }
    await new Promise<void>(resolve => {
      request.getContent((content, encoding) => {
        void (async () => {
          try {
            if (!content) throw new Error('Response body unavailable. Reload the page with DevTools open.');
            const text = encoding === 'base64' ? new TextDecoder().decode(Uint8Array.from(atob(content), c => c.charCodeAt(0))) : content;
            if (text.length > 20_000_000) throw new Error('Skipped response larger than 20 MB.');
            const payload: unknown = JSON.parse(text);
            if (ticket) parseAnnotationDetail(payload, String(ticket.annotationId));
            const envelope = discover(payload);
            if (!envelope.records.length) {
              if (ticket) throw new Error('No annotation record found in the website detail response.');
              return;
            }
            source.reportedTotal = envelope.total;
            source.diagnostics.push(`Detected records at ${envelope.arrayPath || '(root)'}. Passive capture is partial until verified against a scoped server total.`);
            await ingest(envelope.records, source, (await getSettings()).mappings);
            await finish(result);
          } catch (error) {
            source.errors++; source.completeness = 'failed';
            source.diagnostics.push(error instanceof SyntaxError ? 'Malformed JSON response.' : error instanceof Error ? error.message : 'Capture failed.');
            await db.sources.put(source);
            await finish({ ...result, error: 'The website detail response could not be validated or saved. See Sources diagnostics; collection is paused.' });
          } finally { resolve(); }
        })();
      });
    });
  }).catch(error => console.error('Annotation capture storage failed', error instanceof Error ? error.name : 'Unknown error'));
});
window.addEventListener('pagehide', () => { void chrome.storage.session.remove(`devtools:${tabId}`); });
