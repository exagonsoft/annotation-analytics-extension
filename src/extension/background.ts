import { discover } from '../core/parsing';
import { safeUrl } from '../core/privacy';
import { db, getSettings, ingest, newSource } from '../core/storage';
import { interruptReviewJobs } from '../collectors/review-jobs';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => console.error('Unable to configure side panel.'));
  void interruptReviewJobs().catch(() => console.error('Interrupted collection state could not be saved.'));
});
chrome.runtime.onStartup.addListener(() => {
  void interruptReviewJobs().catch(() => console.error('Interrupted collection state could not be saved.'));
});
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'DOM_RECORDS') return;
  if (!sender.tab?.id || !sender.url || !('records' in message) || !Array.isArray(message.records)) return;
  const records: unknown[] = message.records.slice(0, 500);
  const tabId = sender.tab.id;
  const url = safeUrl(sender.url);
  queue = queue.then(async () => {
    const key = `dom:${tabId}`;
    if ((await chrome.storage.session.get(key))[key] !== true) throw new Error('DOM capture is not enabled for this tab.');
    const sourceId = `dom:${tabId}:${new URL(url).origin}`;
    const source = await db.sources.get(sourceId) ?? { ...newSource('dom', url), id: sourceId };
    source.url = url;
    source.diagnostics = ['Rendered rows only. Virtualized and other pages are not included. DOM fields are not network response bodies.'];
    const count = await ingest(discover(records).records, source, (await getSettings()).mappings);
    sendResponse({ ok: true, count });
  }).catch(() => { sendResponse({ ok: false, error: 'DOM records could not be persisted. Verify capture permission and storage.' }); });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove([`dom:${tabId}`, `capture:${tabId}`, `finance-capture:${tabId}`]);
  void interruptReviewJobs(tabId).catch(() => console.error('Closed collection tab state could not be saved.'));
});
