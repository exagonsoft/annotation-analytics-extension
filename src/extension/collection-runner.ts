import { AnnotationDetailCollector } from '../collectors/AnnotationDetailCollector';
import { sessionDetailTransport, detailExecutionError } from '../collectors/detail-session';
import { websiteDetailTransport } from '../collectors/website-session';
import { reviewJobKey, reviewJobSchema } from '../collectors/review-jobs';
import { db } from '../core/storage';

const jobId = new URLSearchParams(location.search).get('job') ?? '';
const status = document.getElementById('status')!;
let collector: AnnotationDetailCollector | null = null;
let acknowledged = false;
const listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (reply: unknown) => void) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !message || typeof message !== 'object') return;
  if (!('type' in message) || message.type !== 'REVIEW_JOB_CONTROL' || !('jobId' in message) || message.jobId !== jobId) return;
  if ('command' in message && collector && (message.command === 'pause' || message.command === 'cancel')) {
    if (message.command === 'pause') collector.pause(); else collector.cancel();
    respond({ ok: true });
  }
};
chrome.runtime.onMessage.addListener(listener);
document.getElementById('pause')!.addEventListener('click', () => collector?.pause());
document.getElementById('cancel')!.addEventListener('click', () => collector?.cancel());

async function run() {
  const key = reviewJobKey(jobId);
  const stored = await chrome.storage.session.get(key);
  const request = reviewJobSchema.parse(stored[key]);
  if (request.id !== jobId) throw new Error('Collection job identity does not match.');
  const tab = await chrome.tabs.getCurrent();
  if (!tab?.id) throw new Error('Background collection requires its own extension tab.');
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  const resume = request.resumeId ? await db.reviewRuns.get(request.resumeId) : undefined;
  if (request.resumeId && !resume) throw new Error('The saved collection run no longer exists.');
  collector = new AnnotationDetailCollector({
    method: request.method, jobId, runnerTabId: tab.id,
    transport: async (id, signal, onStarted) => {
      if (!request.tabId) return { kind: 'error', reason: 'origin', message: 'No collection website was selected. Open the popup on the authorized AI Trainer tab and resume. Saved data does not need a website tab.' };
      return (request.method === 'website' ? websiteDetailTransport(request.tabId) : sessionDetailTransport(request.tabId))(id, signal, onStarted);
    },
    executionContext: request.method === 'website' ?
      'Background collection tab; normal LinkedIn task-link clicks / navigation; website-owned requests captured by DevTools (keep website and DevTools open)' :
      'Background collection tab; chrome.scripting ISOLATED world in selected LinkedIn tab; relative same-origin session GET',
    onProgress: async progress => {
      status.textContent = `${progress.status}: ${progress.completed} completed, ${progress.failed} failed. ${progress.message}`;
      if (!acknowledged) {
        await chrome.storage.session.set({ [key]: { state: 'ready', runId: progress.id } });
        acknowledged = true;
      }
    },
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false;
  await collector.start({ config: request.config, refresh: request.refresh, resume, annotationIds: request.annotationIds });
}
void run().catch(async error => {
  const message = detailExecutionError(error);
  status.textContent = message;
  if (!acknowledged) await chrome.storage.session.set({ [reviewJobKey(jobId)]: { state: 'failed', error: message } });
  else {
    const saved = await db.reviewRuns.filter(run => run.jobId === jobId).first();
    if (saved) await db.reviewRuns.update(saved.id, { status: 'paused', message });
  }
}).finally(async () => {
  chrome.runtime.onMessage.removeListener(listener);
  const tab = await chrome.tabs.getCurrent();
  if (acknowledged) await chrome.storage.session.remove(reviewJobKey(jobId));
  if (tab?.id) await chrome.tabs.remove(tab.id);
});
