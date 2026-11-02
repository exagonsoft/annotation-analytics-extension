import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchingWebsiteTicket, openAnnotationThroughWebsite, websiteDetailKey, websiteDetailTransport, type WebsiteDetailTicket } from '../src/collectors/website-session';
import { DETAIL_PATH, LINKEDIN_ORIGIN } from '../src/core/review';
import { clearCurrent, db, ingest, newSource } from '../src/core/storage';
import { reviewFixture } from './review-fixtures';

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener: (...args: Args) => void) => { listeners.add(listener); },
    removeListener: (listener: (...args: Args) => void) => { listeners.delete(listener); },
    emit: (...args: Args) => { for (const listener of listeners) listener(...args); },
    listeners,
  };
}
function browser() {
  const values: Record<string, unknown> = { 'devtools:12': true };
  const changed = event<[Record<string, chrome.storage.StorageChange>, string]>();
  const removed = event<[number]>();
  const updated = event<[number, chrome.tabs.OnUpdatedInfo]>();
  const get = async (keys: string | string[]) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, values[key]]));
  const set = async (items: Record<string, unknown>) => {
    const changes = Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { oldValue: values[key], newValue }]));
    Object.assign(values, items); changed.emit(changes, 'session');
  };
  const remove = async (key: string) => {
    const oldValue = values[key]; delete values[key]; changed.emit({ [key]: { oldValue } }, 'session');
  };
  let opened!: () => void;
  const navigation = new Promise<void>(resolve => { opened = resolve; });
  const update = vi.fn(async () => { opened(); return { id: 12 }; });
  const executeScript = vi.fn(async () => [{ result: 'navigate' }]);
  vi.stubGlobal('chrome', { storage: { session: { get, set, remove }, onChanged: changed },
    tabs: { onRemoved: removed, onUpdated: updated, update, reload: vi.fn() }, scripting: { executeScript } });
  const ticket = () => {
    const parsed = matchingWebsiteTicket(values[websiteDetailKey(12)], endpoint, 'GET', new Date().toISOString());
    if (!parsed) throw new Error('Expected a pending website collection ticket.');
    return parsed;
  };
  return { values, changed, removed, updated, set, update, executeScript, navigation, ticket };
}
const endpoint = `${LINKEDIN_ORIGIN}${DETAIL_PATH}7901345`;
beforeEach(async () => {
  await clearCurrent();
  await ingest([reviewFixture(7901345, { currentVersionReview: null })], newSource('import', `${LINKEDIN_ORIGIN}/ai-trainer/api/list`), {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('website response correlation', () => {
  it('accepts only a fresh GET for the exact discovered annotation and pending request', () => {
    const ticket: WebsiteDetailTicket = { requestId: crypto.randomUUID(), annotationId: 7901345, requestedAt: Date.now() };
    const started = new Date(ticket.requestedAt).toISOString();
    expect(matchingWebsiteTicket(ticket, endpoint, 'GET', started)).toEqual(ticket);
    expect(matchingWebsiteTicket(ticket, endpoint.replace('7901345', '4010128'), 'GET', started)).toBeNull();
    expect(matchingWebsiteTicket(ticket, endpoint.replace('www.linkedin.com', 'example.test'), 'GET', started)).toBeNull();
    expect(matchingWebsiteTicket(ticket, endpoint, 'POST', started)).toBeNull();
    expect(matchingWebsiteTicket(ticket, endpoint, 'GET', new Date(ticket.requestedAt - 1000).toISOString())).toBeNull();
    expect(matchingWebsiteTicket({ ...ticket, result: { status: 200, started: true, retryAfterMs: null } }, endpoint, 'GET', started)).toBeNull();
  });
  it('clicks only the existing visible same-tab task link, or requests normal navigation/reload', () => {
    vi.stubGlobal('location', { origin: LINKEDIN_ORIGIN, pathname: '/ai-trainer/completed', href: `${LINKEDIN_ORIGIN}/ai-trainer/completed` });
    document.body.innerHTML = `<a href="http://[">Invalid unrelated link</a><a href="${LINKEDIN_ORIGIN}/ai-trainer/tasks/4010128">Wrong task ID</a><a href="${LINKEDIN_ORIGIN}/ai-trainer/tasks/7901345">Annotation</a><button>Submit</button>`;
    const link = document.querySelectorAll('a')[2]!;
    vi.spyOn(link, 'getClientRects').mockReturnValue(Object.assign([new DOMRect()], { item: () => null }));
    const click = vi.spyOn(link, 'click').mockImplementation(() => {});
    expect(openAnnotationThroughWebsite(7901345)).toBe('clicked');
    expect(click).toHaveBeenCalledTimes(1);
    link.target = '_blank';
    expect(openAnnotationThroughWebsite(7901345)).toBe('navigate');
    vi.stubGlobal('location', { origin: LINKEDIN_ORIGIN, pathname: '/ai-trainer/tasks/7901345' });
    expect(openAnnotationThroughWebsite(7901345)).toBe('reload');
    vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/ai-trainer/completed' });
    expect(() => openAnnotationThroughWebsite(7901345)).toThrow('authorized');
  });
});
describe('website navigation transport', () => {
  it('requires DevTools and a discovered ID before any navigation', async () => {
    const mock = browser();
    delete mock.values['devtools:12'];
    expect(await websiteDetailTransport(12)(7901345, new AbortController().signal)).toMatchObject({ kind: 'error', reason: 'execution', message: expect.stringContaining('Open Chrome DevTools') });
    mock.values['devtools:12'] = true;
    expect(await websiteDetailTransport(12)(4010128, new AbortController().signal)).toMatchObject({ kind: 'error', message: expect.stringContaining('not in the discovered') });
    expect(mock.executeScript).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
  });
  it('waits for the matching captured and saved response, not a click or an unrelated result', async () => {
    const mock = browser();
    const started = vi.fn(async () => {});
    const collecting = websiteDetailTransport(12)(7901345, new AbortController().signal, started);
    await mock.navigation;
    expect(mock.update).toHaveBeenCalledWith(12, { url: `${LINKEDIN_ORIGIN}/ai-trainer/tasks/7901345` });
    expect(started).not.toHaveBeenCalled();
    const ticket = mock.ticket();
    await mock.set({ [websiteDetailKey(12)]: { requestId: crypto.randomUUID(), annotationId: 7901345, requestedAt: Date.now(), result: { status: 403, retryAfterMs: null, started: true } } });
    expect(started).not.toHaveBeenCalled();
    await ingest([reviewFixture()], newSource('devtools', endpoint), {});
    await mock.set({ [websiteDetailKey(12)]: { ...ticket, result: { status: 200, retryAfterMs: null, started: true } } });
    expect(await collecting).toMatchObject({ kind: 'response', status: 200, payload: { id: 7901345, taskId: 4010128, currentVersionReview: { annotationScore: 4, status: 'APPROVED' } } });
    expect(started).toHaveBeenCalledTimes(1);
    expect(mock.changed.listeners.size).toBe(0);
    expect(mock.values[websiteDetailKey(12)]).toBeUndefined();
  });
  it.each([403, 302])('returns native HTTP %s without inventing success or retrying navigation', async status => {
    const mock = browser();
    const collecting = websiteDetailTransport(12)(7901345, new AbortController().signal);
    await mock.navigation;
    await mock.set({ [websiteDetailKey(12)]: { ...mock.ticket(), result: { status, retryAfterMs: 120_000, started: true } } });
    expect(await collecting).toMatchObject(status === 403 ? { kind: 'response', status: 403, retryAfterMs: 120_000, payload: null } :
      { kind: 'error', reason: 'execution', status: 302, retryAfterMs: 120_000, message: expect.stringContaining('redirected') });
    expect(mock.update).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'devtools', 'login', 'timeout'] as const)('stops safely on %s and removes its listeners and ticket', async reason => {
    const mock = browser();
    if (reason === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const collecting = websiteDetailTransport(12)(7901345, controller.signal);
    await mock.navigation;
    if (reason === 'cancel') controller.abort();
    if (reason === 'devtools') { delete mock.values['devtools:12']; mock.changed.emit({ 'devtools:12': { oldValue: true } }, 'session'); }
    if (reason === 'login') mock.updated.emit(12, { url: `${LINKEDIN_ORIGIN}/checkpoint` });
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
    if (reason === 'cancel') await expect(collecting).rejects.toMatchObject({ name: 'AbortError' });
    else expect(await collecting).toMatchObject({ kind: 'error', reason: 'execution' });
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(mock.changed.listeners.size).toBe(0);
    expect(mock.updated.listeners.size).toBe(0);
    expect(mock.removed.listeners.size).toBe(0);
    expect(mock.values[websiteDetailKey(12)]).toBeUndefined();
  });
  it('does not count an old cached detail as a newly captured response', async () => {
    const mock = browser();
    await ingest([reviewFixture()], newSource('devtools', endpoint), {});
    await db.records.toCollection().modify(record => { record.detail!.fetchedAt = '2000-01-01T00:00:00.000Z'; });
    const collecting = websiteDetailTransport(12)(7901345, new AbortController().signal);
    await mock.navigation;
    await mock.set({ [websiteDetailKey(12)]: { ...mock.ticket(), result: { status: 200, retryAfterMs: null, started: true } } });
    expect(await collecting).toMatchObject({ kind: 'error', status: 200, message: expect.stringContaining('instead of reusing stale data') });
  });
});
