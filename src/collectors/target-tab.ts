export async function selectedTab(): Promise<number | null> {
  if (globalThis.chrome?.devtools?.inspectedWindow) return chrome.devtools.inspectedWindow.tabId;
  const param = Number(new URLSearchParams(location.search).get('tab'));
  if (Number.isSafeInteger(param) && param > 0) return param;
  const stored = await chrome.storage.session.get('targetTab');
  if (typeof stored.targetTab === 'number' && Number.isSafeInteger(stored.targetTab) && stored.targetTab > 0) return stored.targetTab;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id && tab.url?.startsWith('http') ? tab.id : null;
}
export async function targetTab(): Promise<number> {
  const id = await selectedTab();
  if (id === null) throw new Error('Open the extension popup on your annotation website first to select that tab.');
  return id;
}
