import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectApi, pagination, requestJson, wait } from '../src/collectors/api';
import { importData } from '../src/collectors/import';
import { AnalyticsDB, clearCurrent, db, ingest, newSource, restoreSnapshot, saveSnapshot } from '../src/core/storage';
import { exportRecords } from '../src/core/export';
import { joinRelated } from '../src/collectors/related';
import { fixture, mappings } from './fixtures';

beforeEach(async () => { await clearCurrent(); await db.snapshots.clear(); });
afterEach(() => vi.useRealTimers());
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe('pagination discovery', () => {
  it('detects cursor and preserves filters', () => {
    const next = pagination({ pagination: { nextCursor: 'next-2' } }, 'https://host.test/tasks?project=a', 2);
    expect(new URL(next.url!).searchParams.get('project')).toBe('a');
    expect(new URL(next.url!).searchParams.get('cursor')).toBe('next-2');
    expect(pagination({ pageInfo: { hasNextPage: false } }, 'https://host.test/tasks', 0).terminal).toBe(true);
    expect(pagination({ data: { tasks: { edges: [{ node: fixture() }], pageInfo: { hasNextPage: true, endCursor: 'edge-2' } } } }, 'https://host.test/tasks?after=', 1).url).toContain('after=edge-2');
  });
  it('detects page numbers offset and next links only with real metadata', () => {
    expect(pagination({ page: 1, totalPages: 2 }, 'https://host.test/tasks?page=1&state=SUBMITTED', 5).url).toContain('page=2');
    expect(pagination({ offset: 0, limit: 5, total: 12 }, 'https://host.test/tasks?offset=0', 5).url).toContain('offset=5');
    expect(pagination({ next: '/tasks?page=2' }, 'https://host.test/tasks?state=SUBMITTED', 1).url).toContain('state=SUBMITTED');
    expect(pagination({ next: null }, 'https://host.test/tasks', 1).terminal).toBe(true);
    expect(pagination({ tasks: [fixture()] }, 'https://host.test/tasks?page=1', 1).terminal).toBe(false);
    expect(() => pagination({ next: 'https://evil.test/tasks' }, 'https://host.test/tasks', 1)).toThrow('Cross-origin');
  });
});
describe('API collection', () => {
  it('combines overlapping pages, deduplicates, and marks completeness', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ tasks: [fixture('1'), fixture('2')], pagination: { page: 1, totalPages: 2 }, total: 3 }))
      .mockResolvedValueOnce(response({ tasks: [fixture('2'), fixture('3')], pagination: { page: 2, totalPages: 2 }, total: 3 }));
    const source = await collectApi({ endpoint: 'https://host.test/tasks?page=1&project=one', mappings, maxPages: 10, delayMs: 100, signal: new AbortController().signal, fetcher });
    expect(await db.records.count()).toBe(3);
    expect(source).toMatchObject({ pages: 2, received: 4, duplicates: 1, completeness: 'complete' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('project=one');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', redirect: 'error' });
  });
  it('handles cursor pagination with a terminal cursor', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ records: [fixture('1')], nextCursor: 'abc' })).mockResolvedValueOnce(response({ records: [fixture('2')], nextCursor: null }));
    const source = await collectApi({ endpoint: 'https://host.test/tasks', mappings, maxPages: 5, delayMs: 100, signal: new AbortController().signal, fetcher });
    expect(source.completeness).toBe('complete');
    expect(fetcher.mock.calls[1]?.[0]).toContain('cursor=abc');
  });
  it('retains completed pages on error, cancellation, and page limits', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ tasks: [fixture('1')], nextCursor: 'abc' }));
    const source = await collectApi({ endpoint: 'https://host.test/tasks', mappings, maxPages: 10, delayMs: 100, signal: controller.signal, fetcher, onProgress: () => controller.abort() });
    expect(source.completeness).toBe('partial');
    expect(source.diagnostics.join()).toContain('cancelled');
    expect(await db.records.count()).toBe(1);
    const limited = await collectApi({ endpoint: 'https://host.test/tasks', mappings, maxPages: 1, delayMs: 100, signal: new AbortController().signal, fetcher });
    expect(limited.diagnostics.join()).toContain('safety limit');
    const failed = await collectApi({ endpoint: 'https://host.test/tasks', mappings, maxPages: 2, delayMs: 100, signal: new AbortController().signal, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({}, 403)) });
    expect(failed).toMatchObject({ errors: 1, completeness: 'failed' });
  });
  it('keeps totals partial when pagination is unknown or inconsistent', async () => {
    const unknown = await collectApi({ endpoint: 'https://host.test/tasks', mappings, maxPages: 10, delayMs: 100, signal: new AbortController().signal, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ tasks: [fixture()], total: 50 })) });
    expect(unknown.completeness).toBe('partial');
    const inconsistent = await collectApi({ endpoint: 'https://host.test/tasks', mappings, maxPages: 10, delayMs: 100, signal: new AbortController().signal, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ tasks: [fixture()], total: 50, next: null })) });
    expect(inconsistent.completeness).toBe('partial');
  });
  it('can refresh an existing complete collection without treating overlap as missing data', async () => {
    const options = { endpoint: 'https://host.test/tasks', mappings, maxPages: 1, delayMs: 100, signal: new AbortController().signal };
    await collectApi({ ...options, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ tasks: [fixture()], total: 1 })) });
    const refreshed = await collectApi({ ...options, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ tasks: [fixture()], total: 1 })) });
    expect(refreshed.completeness).toBe('complete');
    expect(await db.records.count()).toBe(1);
  });
  it('retries retryable responses with bounds and supports abortable backoff', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response({ ok: true }));
    const promise = requestJson('https://host.test/tasks', new AbortController().signal, fetcher);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    const waiting = wait(5000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });
  it('honors long Retry-After by stopping instead of retrying too early', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(requestJson('https://host.test/tasks', new AbortController().signal, fetcher)).rejects.toThrow('longer than 30 seconds');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops repeated next links and retains data after a later page fails', async () => {
    const loop = await collectApi({
      endpoint: 'https://host.test/tasks?page=1', mappings, maxPages: 10, delayMs: 100, signal: new AbortController().signal,
      fetcher: vi.fn<typeof fetch>().mockImplementation(async () => response({ tasks: [fixture()], next: '?page=1' })),
    });
    expect(loop.diagnostics.join()).toContain('loop');
    const partial = await collectApi({
      endpoint: 'https://host.test/tasks?page=1', mappings, maxPages: 10, delayMs: 100, signal: new AbortController().signal,
      fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(response({ tasks: [fixture()], next: '?page=2' })).mockResolvedValueOnce(response({}, 403)),
    });
    expect(partial).toMatchObject({ pages: 1, completeness: 'partial', requests: 2 });
    expect(await db.records.count()).toBe(1);
  });
  it('joins a related endpoint only through explicit identity paths', async () => {
    await ingest([fixture('1', { annotationData: null })], newSource('devtools', 'https://host.test/tasks'), mappings);
    const source = await collectApi({
      endpoint: 'https://host.test/results', mappings: { overall: { ...mappings.overall!, path: 'relatedResult.overall' } },
      maxPages: 2, delayMs: 100, signal: new AbortController().signal,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ results: [{ annotationId: '1', overall: 5 }], next: null })),
      join: { arrayPath: 'results', resultIdPath: 'annotationId', annotationIdPath: 'id' },
    });
    expect(source.completeness, source.diagnostics.join('\n')).toBe('complete');
    expect((await db.records.toArray())[0]?.scores.overall.value).toBe(5);
    await joinRelated([{ annotationId: '1', overall: 1 }], newSource('api', 'https://other.test/results'), mappings, { arrayPath: '', resultIdPath: 'annotationId', annotationIdPath: 'id' });
    expect((await db.records.toArray())[0]?.scores.overall.value).toBe(5);
  });
});
describe('IndexedDB and snapshots', () => {
  it('persists records across database connections, preserving distinct IDs', async () => {
    await ingest([fixture('1'), fixture('2'), fixture('1')], newSource('import'), mappings);
    const second = new AnalyticsDB();
    expect(await second.records.count()).toBe(2);
    second.close();
  });
  it('keeps network payloads when DOM fallback sees the same ID', async () => {
    await ingest([fixture()], newSource('devtools', 'https://host.test/tasks'), mappings);
    await ingest([fixture('annotation-1', { annotationData: null })], newSource('dom', 'https://host.test/app'), mappings);
    expect((await db.records.toArray())[0]?.scores.overall.value).toBe(4);
    await ingest([fixture('annotation-1', { projectId: null, annotationData: null })], newSource('dom', 'https://host.test/app'), mappings);
    expect(await db.records.count()).toBe(1);
  });
  it('promotes project-unknown DOM rows to richer network identities', async () => {
    await ingest([fixture('1', { projectId: null, annotationData: null })], newSource('dom', 'https://host.test/app'), mappings);
    await ingest([fixture('1')], newSource('devtools', 'https://host.test/tasks'), mappings);
    expect(await db.records.count()).toBe(1);
    expect((await db.records.toArray())[0]?.projectId).toBe('project-1');
    await ingest([fixture('1', { projectId: 'distinct-project' })], newSource('dom', 'https://host.test/app'), mappings);
    expect(await db.records.count()).toBe(2);
  });
  it('supports snapshot replace and merge', async () => {
    await ingest([fixture('1')], newSource('import'), mappings);
    await saveSnapshot('baseline', mappings);
    const saved = (await db.snapshots.toArray())[0]!;
    await ingest([fixture('2')], newSource('import'), mappings);
    await restoreSnapshot(saved, false, mappings);
    expect(await db.records.count()).toBe(2);
    await restoreSnapshot(saved, true, mappings);
    expect(await db.records.count()).toBe(1);
  });
  it('round-trips JSON and JSONL exports without losing identity', async () => {
    await importData(JSON.stringify({ tasks: [fixture('1'), fixture('2')] }), mappings);
    const rows = await db.records.toArray();
    await importData(exportRecords(rows, 'json'), mappings);
    expect(await db.records.count()).toBe(2);
    await importData(exportRecords(rows, 'jsonl'), mappings);
    expect(await db.records.count()).toBe(2);
  });
});
