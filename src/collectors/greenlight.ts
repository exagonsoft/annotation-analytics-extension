import { financialDomSchema, saveFinancialDom } from '../core/finance-storage';
import { GREENLIGHT_PORTAL } from '../core/finance';

export interface GreenlightCaptureState {
  enabled: boolean;
  received: number;
  capturedAt: string | null;
  start: string | null;
  end: string | null;
  status: number | null;
  error: string | null;
}
export const greenlightCaptureKey = (tabId: number) => `finance-capture:${tabId}`;

export function readGreenlightDashboard() {
  if (location.origin !== 'https://portal.greenlight.ai' || location.pathname !== '/dashboard') throw new Error('Selected tab is not the authorized Greenlight dashboard.');
  const content = document.querySelector('[class*="dashboard_time__"]');
  if (!content) throw new Error('Greenlight time section is not rendered. Sign in and open the dashboard.');
  const heading = content.querySelector('[class*="quick_heading__"]');
  const period = heading?.firstElementChild?.textContent?.trim();
  if (!period) throw new Error('Rendered Greenlight week could not be identified.');
  const parseMoney = (text: string) => {
    const match = /^\s*(-?)\$\s*([\d,]+)(?:\.(\d{1,2}))?\s*$/.exec(text);
    if (!match || !/^\d+(?:,\d{3})*$/.test(match[2]!)) throw new Error('Rendered USD amount has an unsupported format.');
    const result = Number(match[2]!.replaceAll(',', '')) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
    if (!Number.isSafeInteger(result)) throw new Error('Rendered USD amount exceeds the supported range.');
    return match[1] ? -result : result;
  };
  const rates = [...document.querySelectorAll('[class*="engagement_engagement__"]')].flatMap(engagement => {
    const name = engagement.querySelector('[class*="engagement_title__"]')?.textContent?.trim();
    const label = [...engagement.querySelectorAll('[class*="engagement_label__"]')].find(element => element.textContent?.trim() === 'Pay Rate');
    const text = label?.nextElementSibling?.textContent?.trim();
    if (!name || !text) return [];
    const match = /^(.+?)\s*\/\s*([a-zA-Z ]+)$/.exec(text);
    if (!match) throw new Error('Rendered pay rate has an unsupported unit. No rate was guessed.');
    return [{ name, cents: parseMoney(match[1]!), unit: match[2]!.trim().toLowerCase() }];
  });
  const rows = [...content.querySelectorAll('[class*="container_data__"]')].map(row => {
    const cells = [...row.children];
    const details = cells[1], dateStatus = cells[2];
    const rawDate = dateStatus?.children[0]?.textContent?.trim() ?? '';
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(rawDate);
    if (!match) throw new Error('Rendered deliverable date has an unsupported format.');
    const date = `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`;
    const day = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) throw new Error('Rendered deliverable date is invalid.');
    const status = dateStatus?.children[1]?.textContent?.trim();
    const engagement = details?.children[0]?.textContent?.trim();
    const amount = cells[3]?.textContent?.trim();
    const tag = cells[4]?.textContent?.trim() ?? '';
    if (!status || !engagement || !amount) throw new Error('Rendered deliverable is missing its engagement, amount or payment status.');
    return { engagement, date, status, amountCents: parseMoney(amount), tag };
  });
  const header = content.querySelector('[class*="quick_deliverables__"] [class*="quick_header__"]')?.textContent ?? '';
  const count = /Deliverables\s*\((\d+)\)/i.exec(header);
  if (!count || Number(count[1]) !== rows.length) throw new Error('Expand the Deliverables section and render all rows for this week before DOM collection. Partial rows are not treated as a complete week.');
  return { period, rates, rows };
}
export function previousGreenlightWeek(): string {
  if (location.origin !== 'https://portal.greenlight.ai' || location.pathname !== '/dashboard') throw new Error('Selected tab left the Greenlight dashboard.');
  const heading = document.querySelector('[class*="dashboard_time__"] [class*="quick_heading__"]');
  const period = heading?.firstElementChild?.textContent?.trim();
  const button = heading?.querySelector<HTMLButtonElement>('[class*="quick_arrows__"] button:first-child');
  if (!period || !button || button.disabled || !button.querySelector('[data-icon="chevron-left"]')) throw new Error('The read-only previous-week control is unavailable. Navigate the week normally and capture its response.');
  button.click();
  return period;
}
export async function greenlightTabs(): Promise<chrome.tabs.Tab[]> {
  return (await chrome.tabs.query({ url: `${GREENLIGHT_PORTAL}/dashboard*` })).filter(tab => {
    if (!tab.url) return false;
    const url = new URL(tab.url);
    return url.origin === GREENLIGHT_PORTAL && url.pathname === '/dashboard';
  });
}
export async function collectGreenlightDom(tabId: number) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: readGreenlightDashboard });
  if (!result?.result) throw new Error('Chrome returned no rendered Greenlight data. Check the selected dashboard and host permission.');
  return saveFinancialDom(financialDomSchema.parse(result.result));
}
export async function armGreenlightCapture(tabId: number, enabled: boolean): Promise<void> {
  const key = greenlightCaptureKey(tabId);
  if (enabled && (await chrome.storage.session.get(`devtools:${tabId}`))[`devtools:${tabId}`] !== true) {
    throw new Error('Open DevTools on the selected Greenlight dashboard and reopen it after updating the extension. Native JSON capture needs its Annotation Analytics integration.');
  }
  const previous = (await chrome.storage.session.get(key))[key] as GreenlightCaptureState | undefined;
  await chrome.storage.session.set({ [key]: { enabled, received: previous?.received ?? 0, capturedAt: previous?.capturedAt ?? null,
    start: previous?.start ?? null, end: previous?.end ?? null, status: previous?.status ?? null, error: null } satisfies GreenlightCaptureState });
}
export async function collectPreviousGreenlightWeek(tabId: number, signal: AbortSignal): Promise<void> {
  await armGreenlightCapture(tabId, true);
  const key = greenlightCaptureKey(tabId), requestedAt = new Date().toISOString();
  const oldDom = await collectGreenlightDom(tabId);
  const displayed = /^Week of (.+?)\s+-\s+(.+)$/i.exec(oldDom.period);
  const oldStart = displayed ? Date.parse(`${displayed[1]!.replace(/(\d+)(?:st|nd|rd|th)/g, '$1')} UTC`) : NaN;
  if (!Number.isFinite(oldStart)) throw new Error('The displayed week has an unsupported date format. Navigate weeks normally with capture armed.');
  const expectedStart = new Date(oldStart - 7 * 86_400_000).toISOString().slice(0, 10);
  const oldState = (await chrome.storage.session.get(key))[key] as GreenlightCaptureState;
  let cleanup = () => {};
  const captured = new Promise<void>((resolve, reject) => {
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      const state = changes[key]?.newValue as GreenlightCaptureState | undefined;
      if (!state?.capturedAt || state.capturedAt < requestedAt) return;
      if (state.error || !state.enabled) { reject(new Error(state.error ?? 'Financial capture was stopped.')); return; }
      if (state.received > oldState.received && state.start?.slice(0, 10) === expectedStart) resolve();
    };
    const abort = () => reject(new Error('Financial week collection cancelled. Saved records remain; a website request already started may still finish.'));
    const timer = setTimeout(() => reject(new Error('No new Greenlight week response was captured within 60 seconds. Keep DevTools open; no retry was made.')), 60_000);
    chrome.storage.onChanged.addListener(changed);
    signal.addEventListener('abort', abort, { once: true });
    cleanup = () => { clearTimeout(timer); chrome.storage.onChanged.removeListener(changed); signal.removeEventListener('abort', abort); };
  });
  void captured.catch(() => {});
  try {
    signal.throwIfAborted();
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: previousGreenlightWeek });
    if (result?.result !== oldDom.period) throw new Error('The Greenlight week changed during navigation. Stop and collect the visible week explicitly.');
    await captured;
    const snapshot = await collectGreenlightDom(tabId);
    if (snapshot.period === oldDom.period) throw new Error('The API response was saved, but the rendered week has not changed yet. Collect the new rendered week once the portal finishes updating.');
  } finally {
    cleanup();
    // A failed injection must not leave an unhandled timeout rejection.
    void captured.catch(() => {});
  }
}
