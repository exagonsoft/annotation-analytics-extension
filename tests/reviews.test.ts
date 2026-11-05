import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { AnalyticsDB, clearCurrent, db, ingest, newSource, rebuildBatchJoins, remap, restoreSnapshot, saveSnapshot } from '../src/core/storage';
import { detailCollection, hasCachedDetail, LINKEDIN_ORIGIN, mergeReviewRecord, parseAnnotationDetail, reviewDiagnosticsReport } from '../src/core/review';
import { normalize } from '../src/core/parsing';
import { emptyReviewFilters, filterReviews, reviewCsv, reviewScore, reviewState, summarizeReviews } from '../src/core/review-analytics';
import { AnnotationDetailCollector } from '../src/collectors/AnnotationDetailCollector';
import type { DetailTransport, PageDetailResponse } from '../src/collectors/detail-session';
import { exportRecords } from '../src/core/export';
import { importData } from '../src/collectors/import';
import { fixture } from './fixtures';
import { reviewFixture } from './review-fixtures';
import { interruptReviewJobs } from '../src/collectors/review-jobs';
import { filterRecords } from '../src/core/analytics';
import { emptyFilters } from '../src/core/model';
import { annotationPaymentCoverage, normalizeFinancialTime } from '../src/core/finance';
import { financeFixture } from './finance-fixtures';

const sourceUrl = `${LINKEDIN_ORIGIN}/ai-trainer/api/list`;
const config = { concurrency: 1, delayMs: 500, maxRetries: 1 };
const success = (id: number, overrides = {}): PageDetailResponse => ({ kind: 'response', status: 200, retryAfterMs: null, payload: reviewFixture(id, overrides) });
const exclusive = async <T>(work: () => Promise<T>) => work();
async function seed(ids = [7901345]) {
  await ingest(ids.map(id => fixture(String(id), { taskId: 4010128, projectId: 989007 })), newSource('import', sourceUrl), {});
}
function row(id = 7901345, overrides = {}) {
  const record = normalize(fixture(String(id), { taskId: 4010128, projectId: 989007 }), newSource('import', sourceUrl))!;
  return mergeReviewRecord(record, detailCollection(parseAnnotationDetail(reviewFixture(id, overrides)), 'import'));
}
beforeEach(async () => { await clearCurrent(); await db.snapshots.clear(); });

describe('background collection recovery', () => {
  it('interrupts only the closed runner and preserves verified details while releasing unfinished claims', async () => {
    await seed([7901345, 7901346]);
    const run = await new AnnotationDetailCollector({ exclusive, jobId: crypto.randomUUID(), runnerTabId: 42, transport: async id => success(Number(id)) }).start({ config });
    const records = await db.records.toArray();
    await db.reviewRuns.update(run.id, { status: 'running' });
    for (const [index, record] of records.entries()) {
      await db.records.put({ ...record, detail: { ...record.detail!, status: 'fetching', attemptRunId: run.id,
        ...(index === 1 ? { data: null, verified: false } : {}) } });
    }
    await interruptReviewJobs(99);
    expect((await db.reviewRuns.get(run.id))?.status).toBe('running');
    await interruptReviewJobs(42);
    expect((await db.reviewRuns.get(run.id))?.status).toBe('interrupted');
    expect((await db.records.get(records[0]!.key))?.detail).toMatchObject({ status: 'complete', verified: true, data: { review: { annotationScore: 4 } } });
    expect((await db.records.get(records[1]!.key))?.detail).toMatchObject({ status: 'pending', data: null });
  });
});

describe('confirmed review contract', () => {
  it('parses annotation 7901345 as score 4 / APPROVED with feedback and numeric epoch times', () => {
    expect(parseAnnotationDetail(reviewFixture(), '7901345')).toMatchObject({
      id: 7901345, taskId: 4010128, createdAt: 1793478535000, endedAt: 1793555768000, durationInSeconds: 7,
      review: { annotationScore: 4, status: 'APPROVED', reviewed: true, feedback: expect.stringContaining('Synthetic reviewer feedback') },
    });
    expect(() => parseAnnotationDetail(reviewFixture(), '4010128')).toThrow('does not match');
    expect(parseAnnotationDetail(reviewFixture())).not.toHaveProperty('nextResultId');
  });
  it('distinguishes no review, reviewed without score and unknown status', () => {
    expect(parseAnnotationDetail(reviewFixture(1, { currentVersionReview: undefined })).review).toEqual({ reviewed: false, annotationScore: null, feedback: null, status: null });
    expect(parseAnnotationDetail(reviewFixture(1, { currentVersionReview: { annotationScore: null, status: 'FUTURE_STATUS' } })).review).toMatchObject({ reviewed: true, annotationScore: null, status: 'FUTURE_STATUS' });
    for (const invalid of ['4', NaN, {}, Infinity]) expect(parseAnnotationDetail(reviewFixture(1, { currentVersionReview: { annotationScore: invalid } })).review.annotationScore).toBeNull();
    expect(parseAnnotationDetail(reviewFixture(1, { currentVersionReview: { annotationScore: 0 } })).review.annotationScore).toBe(0);
    expect(() => parseAnnotationDetail({ id: 1, state: false })).toThrow('Invalid');
  });
  it('separates quality from task answers, strips profiles and large configuration, and sanitizes feedback', () => {
    const record = normalize(reviewFixture(), newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901345`))!;
    expect(record.detail?.data?.review.annotationScore).toBe(4);
    expect(record.scores.overall.value).toBeNull();
    const incorrectlyMapped = normalize(reviewFixture(), newSource('import', sourceUrl), {
      overall: { path: 'currentVersionReview.annotationScore', kind: 'numeric', scale: 'unverified', min: 0, max: 5, level: 'annotation' },
    })!;
    expect(incorrectlyMapped.scores.overall.scoringStatus).toBe('invalid');
    expect(incorrectlyMapped.scores.overall.value).toBeNull();
    expect(record.createdAt).toBe(new Date(1793478535000).toISOString());
    expect(JSON.stringify(record)).not.toContain('Synthetic fixture identity');
    expect(JSON.stringify(record)).not.toContain('Do not retain project configuration');
    expect(JSON.stringify(record)).not.toContain('fixture@example.test');
    expect(parseAnnotationDetail(reviewFixture(1, { currentVersionReview: { feedback: 'Authorization: test-only-placeholder', annotationScore: 4 } })).review.feedback).toBe('[REDACTED]');
  });
  it('preserves allowlisted batch metadata through enrichment, listing updates, remapping, exports and snapshots without re-fetching', async () => {
    const name = 'Webapp Preference - 320 - Set AF - 2026-10-31';
    await seed();
    await ingest([reviewFixture(7901345, { pipeline: { id: 7001, name, configuration: 'not-retained' },
      pipelineStage: { id: 7101, type: 'ATTEMPT', configuration: 'not-retained' } })], newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901345`), {});
    await ingest([fixture('7901345', { projectId: 989007, iterationId: 3188053 })], newSource('import', sourceUrl), {});
    await remap({});
    const saved = (await db.records.toArray())[0]!;
    expect(saved.detail?.data).toMatchObject({ pipelineId: 7001, pipelineName: name, pipelineStageType: 'ATTEMPT' });
    expect(saved.pipeline).toMatchObject({ id: 7001, name });
    expect(JSON.stringify(saved)).not.toContain('not-retained');
    const transport = vi.fn<DetailTransport>();
    await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(transport).not.toHaveBeenCalled();
    await saveSnapshot('Batch metadata', {});
    const snapshot = (await db.snapshots.toArray())[0]!;
    const exported = exportRecords([saved], 'json');
    await clearCurrent();
    await importData(exported, {});
    expect((await db.records.toArray())[0]!.detail?.data?.pipelineName).toBe(name);
    await restoreSnapshot(snapshot, true, {});
    expect((await db.records.toArray())[0]!.detail?.data?.pipelineStageType).toBe('ATTEMPT');
    const changed = mergeReviewRecord(saved, detailCollection(parseAnnotationDetail(reviewFixture(7901345, { pipeline: { id: 9999 }, iterationId: 9998 })), 'import'));
    expect(changed.detail?.data?.pipelineName).toBeNull();
    expect(changed.detail?.data?.pipelineStageType).toBeNull();
    const sparse = mergeReviewRecord(saved, detailCollection(parseAnnotationDetail(reviewFixture(7901345, { pipeline: null })), 'import'));
    expect(sparse.pipeline).toMatchObject({ id: '7001', name });
  });
  it('repairs existing verified records from an imported project pipeline/stage catalog and persists the joined keys without any task GET', async () => {
    const f = 'Webapp Preference - 320 - Set F - 2026-10-31', g = 'Webapp Preference - Set G - 2026-10-31';
    await ingest([reviewFixture(1, { projectId: 77, iterationId: 101, pipeline: { id: 901 } }),
      reviewFixture(2, { projectId: 77, iterationId: 102, pipeline: null })], newSource('import', sourceUrl), {});
    const fetchedAt = (await db.records.where('id').equals('1').first())!.detail!.fetchedAt;
    await ingest([reviewFixture(3, { projectId: 77, iterationId: 101, pipeline: { id: 901, name: f },
      project: { id: 77, projectConfig: 'DO_NOT_RETAIN', pipelines: [
        { id: 901, name: f, stages: [{ iterationId: 101, type: 'ATTEMPT', configuration: 'DO_NOT_RETAIN' }] },
        { id: 902, name: g, stages: [{ iterationId: 102, type: 'ATTEMPT' }] },
      ] } })], newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/3`), {});
    const first = (await db.records.where('id').equals('1').first())!, second = (await db.records.where('id').equals('2').first())!;
    expect(first).toMatchObject({ batchKey: 'webapp preference - set f - 2026-10-31',
      detail: { verified: true, fetchedAt, data: { pipelineName: f, pipelineStageType: 'ATTEMPT' } } });
    expect(second).toMatchObject({ batchKey: 'webapp preference - set g - 2026-10-31',
      pipeline: { id: '902', name: g }, detail: { verified: true, data: { pipelineStageType: 'ATTEMPT' } } });
    expect(await db.annotationBatches.count()).toBe(2);
    expect(JSON.stringify(await db.annotationBatches.toArray())).not.toContain('DO_NOT_RETAIN');
    expect(JSON.stringify((await db.records.where('id').equals('3').first())!)).not.toContain('projectConfig');
    expect(await rebuildBatchJoins()).toBe(0);
    const transport = vi.fn<DetailTransport>();
    await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(transport).not.toHaveBeenCalled();
    const payload = financeFixture();
    payload.deliverables = [payload.deliverables[0]!];
    payload.deliverables[0]!.notes = 'TAG|Webapp Preference - Set F - 2026-10-31- Att: 2, Rev: 0;';
    const payments = normalizeFinancialTime(payload).payments;
    const records = await db.records.toArray();
    expect(filterRecords(records, { ...emptyFilters, paymentState: 'paid' }, payments).map(record => record.id).sort()).toEqual(['1', '3']);
    expect(filterRecords(records, { ...emptyFilters, paymentState: 'pending' }, payments).map(record => record.id)).toEqual(['2']);
    expect(filterRecords(records, { ...emptyFilters, batchKey: first.batchKey! }, payments)).toHaveLength(2);
    const reopened = new AnalyticsDB();
    try { expect(await reopened.annotationBatches.count()).toBe(2); } finally { reopened.close(); }
  });
  it('exports full-batch payment counts for a subset and round-trips listing-only recovered labels without fabricating a review', async () => {
    const name = 'Webapp Preference - 320 - Set AF - 2026-10-31';
    await ingest([fixture('3', { projectId: 77, iterationId: 101, pipeline: { id: 901 }, iteration: null }),
      reviewFixture(1, { projectId: 77, iterationId: 101, pipeline: { id: 901, name }, project: { id: 77, pipelines: [
        { id: 901, name, stages: [{ iterationId: 101, type: 'ATTEMPT' }] },
      ] } }),
      reviewFixture(2, { projectId: 77, iterationId: 101, pipeline: { id: 901, name } }),
    ], newSource('import', sourceUrl), {});
    const records = await db.records.toArray(), listing = records.find(record => record.id === '3')!;
    expect(hasCachedDetail(listing)).toBe(false);
    const payload = financeFixture();
    payload.deliverables = [payload.deliverables[0]!];
    payload.deliverables[0]!.notes = 'TAG|Webapp Preference - Set AF - 2026-10-31- Att: 1, Rev: 0;';
    const coverage = annotationPaymentCoverage(records, normalizeFinancialTime(payload).payments);
    expect(JSON.parse(exportRecords([listing], 'json', coverage))[0].batchPaymentCoverage).toMatchObject({ state: 'partial', paid: 1, remaining: 2 });
    expect(exportRecords([listing], 'csv', coverage)).toContain('"Partially paid batch","1","2"');
    const exported = exportRecords([listing], 'json', coverage);
    await clearCurrent();
    await importData(exported, {});
    const restored = (await db.records.toArray())[0]!;
    expect(restored).toMatchObject({ batchKey: listing.batchKey, pipeline: listing.pipeline, iteration: listing.iteration });
    expect(hasCachedDetail(restored)).toBe(false);
    expect(restored.scores.overall.value).toBeNull();
  });
});
describe('review analytics, filters and exports', () => {
  const rows = [
    row(), row(7901346, { currentVersionReview: { annotationScore: 0, status: 'REJECTED', feedback: 'Needs improvement' } }),
    row(7901347, { currentVersionReview: { annotationScore: null, status: null } }), row(7901348, { currentVersionReview: null }),
    normalize(fixture('7901349'), newSource('import', sourceUrl))!,
  ];
  it('uses only numeric scores and defines the known-status approval denominator', () => {
    expect(summarizeReviews(rows)).toMatchObject({
      total: 5, collected: 4, pending: 1, reviewed: 3, approved: 1, otherStatuses: 1, unknownStatuses: 1,
      missingReviews: 1, scored: 2, average: 2, min: 0, max: 4, median: 2, approvalDenominator: 2, approvalRate: 50,
    });
    expect(summarizeReviews([rows[4]!]).average).toBeNull();
    expect(reviewState(rows[4]!)).toBe('Detail not fetched');
    expect(reviewState(rows[3]!)).toBe('Fetched, no review');
    expect(reviewState(rows[2]!)).toBe('Reviewed, no numeric score');
  });
  it('combines review status, exact zero score, project, date, feedback and cache filters', () => {
    expect(filterReviews(rows, { ...emptyReviewFilters, exact: '0', project: '989007', reviewStatus: 'REJECTED', hasFeedback: 'yes' }).map(r => r.id)).toEqual(['7901346']);
    expect(filterReviews(rows, { ...emptyReviewFilters, hasReview: 'no' }).map(r => r.id)).toEqual(['7901348']);
    const day = new Date(1793555768000).toISOString().slice(0, 10);
    expect(filterReviews(rows, { ...emptyReviewFilters, from: day, to: day, dateBasis: 'submitted' })).toHaveLength(4);
    expect(filterReviews(rows, { ...emptyReviewFilters, min: '1', max: '5', search: 'synthetic', collected: 'yes' })).toHaveLength(1);
    expect(filterReviews(rows, { ...emptyReviewFilters, hasScore: 'no' })).toHaveLength(2);
  });
  it('exports complete feedback safely and never writes missing scores as zero', () => {
    const record = row(7901350, { currentVersionReview: { feedback: '=HYPERLINK("test")', annotationScore: null, status: 'APPROVED' } });
    const csv = reviewCsv([record]);
    expect(csv).toContain('annotation_id,task_id,task_title');
    expect(csv).toContain('7901350');
    expect(csv).toContain('4010128');
    expect(csv).toContain('\'=HYPERLINK');
    expect(csv).toContain('"APPROVED","","true"');
  });
});
describe('detail queue and durable enrichment', () => {
  it('reports an empty listing as a blocked zero-request run, not successful collection', async () => {
    const transport = vi.fn<DetailTransport>();
    await expect(new AnnotationDetailCollector({ transport, exclusive }).start({ config })).rejects.toThrow('Collect the authorized paginated listing');
    expect(transport).not.toHaveBeenCalled();
    const run = (await db.reviewRuns.toArray())[0]!;
    expect(run.status).toBe('paused');
    expect(run.diagnostics).toMatchObject({ discovered: 0, eligible: 0, queued: 0, started: 0 });
    expect(run.diagnostics?.latestError).toContain('Found 0 annotation IDs');
  });
  it.each([undefined, null, {}])('does not treat completed-list timing or default review %j as fetched detail', async currentVersionReview => {
    await ingest([reviewFixture(7901345, { currentVersionReview })], newSource('devtools', sourceUrl), {});
    expect((await db.records.toArray())[0]?.detail?.data ?? null).toBeNull();
    const transport = vi.fn<DetailTransport>().mockImplementation(async id => success(id));
    const run = await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(transport.mock.calls.map(call => call[0])).toEqual([7901345]);
    expect(run.completed).toBe(1);
  });
  it('caches a no-review response only when it was actually collected from the detail endpoint', async () => {
    await ingest([reviewFixture(7901345, { currentVersionReview: null })], newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901345`), {});
    expect(hasCachedDetail((await db.records.toArray())[0]!)).toBe(true);
    const transport = vi.fn<DetailTransport>();
    const run = await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(transport).not.toHaveBeenCalled();
    expect(run.message).toContain('No requests queued');
    expect(run.diagnostics).toMatchObject({ eligible: 1, skippedCache: 1, queued: 0, started: 0 });
  });
  it('runs a selected diagnostic ID once through the normal queue and refuses undiscovered IDs', async () => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockResolvedValue({ kind: 'response', status: 503, payload: null, retryAfterMs: null });
    const collector = new AnnotationDetailCollector({ transport, exclusive });
    const run = await collector.start({ config: { ...config, maxRetries: 0 }, annotationIds: ['7901345'], refresh: true });
    expect(transport.mock.calls.map(call => call[0])).toEqual([7901345]);
    expect(run.status).toBe('partial');
    expect(run.diagnostics).toMatchObject({ discovered: 2, eligible: 2, queued: 1, dispatched: 1, started: 1, completed: 1, failed: 1, httpCodes: { '503': 1 } });
    expect(run.diagnostics?.events.at(-1)).toMatchObject({ type: 'DETAIL_REQUEST_FAILED', annotationId: '7901345', status: 503 });
    await expect(collector.start({ annotationIds: ['4010128'] })).rejects.toThrow('not found');
    expect(transport).toHaveBeenCalledTimes(1);
    const report = reviewDiagnosticsReport(run);
    expect(report).toContain('/ai-trainer/api/frontendAnnotationTaskResults/7901345');
    expect(report).not.toContain('currentVersionReview');
    expect(report).not.toContain('Synthetic reviewer feedback');
  });
  it('records execution denial without claiming any browser GET started', async () => {
    await seed();
    const transport: DetailTransport = async () => ({ kind: 'error', reason: 'permission', started: false, message: 'Cannot access contents of the selected tab. Missing host permission.' });
    const run = await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(run.status).toBe('paused');
    expect(run.diagnostics).toMatchObject({ dispatched: 1, started: 0, completed: 0, failed: 1, httpCodes: {} });
    expect(run.diagnostics?.latestError).toContain('Missing host permission');
    expect((await db.records.toArray())[0]?.detail?.status).toBe('failed');
  });
  it('preserves useful Chrome execution errors while removing URLs and their sensitive queries', async () => {
    await seed();
    const transport = vi.fn<DetailTransport>().mockRejectedValue(new Error('Cannot access contents of https://www.linkedin.com/ai-trainer?session_token=synthetic-fixture-only due to missing host permission.'));
    const run = await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(run.status).toBe('paused');
    expect(run.diagnostics?.latestError).toContain('Cannot access contents');
    expect(run.diagnostics?.latestError).toContain('missing host permission');
    expect(reviewDiagnosticsReport(run)).not.toContain('synthetic-fixture-only');
    expect(run.diagnostics).toMatchObject({ dispatched: 1, started: 0, failed: 1 });
  });
  it('persists a start event before a slow fetch settles and does not retry invalid HTTP 200 JSON', async () => {
    await seed();
    let finish!: (value: PageDetailResponse) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const transport: DetailTransport = async (_id, _signal, onStarted) => {
      await onStarted?.(); started();
      return new Promise(resolve => { finish = resolve; });
    };
    const running = new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    await ready;
    expect((await db.reviewRuns.toArray())[0]?.diagnostics).toMatchObject({ dispatched: 1, started: 1, completed: 0 });
    finish({ kind: 'error', reason: 'json', status: 200, started: true, message: 'HTTP 200 returned a login page, not JSON.' });
    const run = await running;
    expect(run.status).toBe('partial');
    expect(run.diagnostics).toMatchObject({ started: 1, completed: 1, failed: 1, httpCodes: { '200': 1 } });
  });
  it('requests annotation IDs sequentially, merges details and caches successes', async () => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockImplementation(async id => success(id));
    const collector = new AnnotationDetailCollector({ transport, exclusive });
    expect((await collector.start({ config })).status).toBe('complete');
    expect(transport.mock.calls.map(call => call[0])).toEqual([7901345, 7901346]);
    expect(await db.records.count()).toBe(2);
    expect((await db.records.toArray())[0]?.taskId).toBe('4010128');
    await collector.start({ config });
    expect(transport).toHaveBeenCalledTimes(2);
    await collector.start({ config, refresh: true });
    expect(transport).toHaveBeenCalledTimes(4);
    await ingest([fixture('7901345', { projectId: 989007 })], newSource('import', sourceUrl), {});
    await remap({});
    expect((await db.records.where('id').equals('7901345').first())?.detail?.data?.review.annotationScore).toBe(4);
  });
  it.each(['session', 'website'] as const)('retains the %s cache across reopen, list re-import, old timestamps and a failed explicit refresh', async method => {
    await seed();
    await new AnnotationDetailCollector({ method, transport: async id => success(id), exclusive }).start({ config });
    const refresh = vi.fn<DetailTransport>().mockResolvedValue({ kind: 'response', status: 503, payload: null, retryAfterMs: null });
    await new AnnotationDetailCollector({ method, transport: refresh, exclusive }).start({ config: { ...config, maxRetries: 0 }, refresh: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    await db.records.toCollection().modify(record => { record.detail!.fetchedAt = '2000-01-01T00:00:00.000Z'; });
    db.close(); await db.open();
    await seed();
    const transport = vi.fn<DetailTransport>();
    const run = await new AnnotationDetailCollector({ method, transport, exclusive }).start({ config });
    expect(transport).not.toHaveBeenCalled();
    expect(run.diagnostics).toMatchObject({ skippedCache: 1, queued: 0, dispatched: 0 });
    expect((await db.records.toArray())[0]?.detail).toMatchObject({ verified: true, data: { review: { annotationScore: 4 } } });
  });
  it.each(['session', 'website'] as const)('skips a %s queue item enriched by capture while an earlier item was running', async method => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockImplementation(async id => {
      if (id === 7901345) await ingest([reviewFixture(7901346)], newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901346`), {});
      return success(id);
    });
    const run = await new AnnotationDetailCollector({ method, transport, exclusive }).start({ config });
    expect(transport.mock.calls.map(call => call[0])).toEqual([7901345]);
    expect(run.diagnostics).toMatchObject({ skippedCache: 1, queued: 2, dispatched: 1, started: 1 });
    expect(summarizeReviews(await db.records.toArray())).toMatchObject({ collected: 2, pending: 0 });
  });
  it('resumes a refresh without repeating a native result saved just before pause', async () => {
    await seed();
    await new AnnotationDetailCollector({ transport: async id => success(id), exclusive }).start({ config });
    const transport = vi.fn<DetailTransport>().mockImplementation(async id => {
      await ingest([reviewFixture(id)], newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/${id}`), {});
      collector.pause();
      return success(id);
    });
    const collector: AnnotationDetailCollector = new AnnotationDetailCollector({ method: 'website', transport, exclusive });
    const paused = await collector.start({ config, refresh: true });
    expect(paused.status).toBe('paused');
    expect((await db.records.toArray())[0]?.detail?.completedRunId).toBe(paused.id);
    const resumed = await new AnnotationDetailCollector({ method: 'website', transport, exclusive }).start({ resume: paused });
    expect(resumed.status).toBe('complete');
    expect(resumed.diagnostics).toMatchObject({ skippedCache: 1, queued: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps verified cached details when merging a snapshot that predates enrichment', async () => {
    await seed();
    await saveSnapshot('Before enrichment', {});
    const snapshot = (await db.snapshots.toArray())[0]!;
    await new AnnotationDetailCollector({ transport: async id => success(id), exclusive }).start({ config });
    await restoreSnapshot(snapshot, false, {});
    expect((await db.records.toArray())[0]?.detail).toMatchObject({ verified: true, data: { review: { annotationScore: 4 } } });
    const transport = vi.fn<DetailTransport>();
    await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(transport).not.toHaveBeenCalled();
  });
  it('retries transient errors, tracks attempts and continues after ordinary failures', async () => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockResolvedValueOnce({ kind: 'response', status: 503, retryAfterMs: 0, payload: null })
      .mockResolvedValueOnce(success(7901345)).mockResolvedValueOnce({ kind: 'response', status: 404, retryAfterMs: null, payload: null });
    await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    const saved = await db.records.where('id').equals('7901345').first();
    expect(saved?.detail).toMatchObject({ status: 'complete', attempts: 2, errors: [expect.objectContaining({ status: 503 })] });
    expect((await db.records.where('id').equals('7901346').first())?.detail?.status).toBe('failed');
  });
  it.each([
    [401, 'did not accept authentication'],
    [403, 'The exact reason is unknown'],
    [429, 'server rate-limited'],
  ] as const)('pauses immediately on HTTP %s with status-specific guidance, without enumerating nextResultId', async (status, guidance) => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockResolvedValue({ kind: 'response', status, retryAfterMs: 120_000, payload: null });
    const collector = new AnnotationDetailCollector({ transport, exclusive });
    const run = await collector.start({ config });
    expect(run.status).toBe('paused');
    expect(run.message).toContain(guidance);
    expect(run.diagnostics?.latestError).toContain(guidance);
    expect(transport).toHaveBeenCalledTimes(1);
    const detail = (await db.records.where('id').equals('7901345').first())?.detail;
    expect(detail?.status).toBe('failed');
    expect(detail?.errors.at(-1)).toMatchObject({ status, message: expect.stringContaining(guidance) });
    if (status === 403) {
      expect(run.message).toContain('keep this queue paused');
      expect(run.message).toContain('Start capture');
      expect(run.message).not.toContain('rate limit');
    }
    await expect(collector.start({ config, refresh: true })).rejects.toThrow('Retry-After');
  });
  it('merges a normally captured review after a refused request without retrying the denied endpoint', async () => {
    await seed();
    const transport = vi.fn<DetailTransport>().mockResolvedValue({ kind: 'response', status: 403, retryAfterMs: null, payload: null });
    const paused = await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(paused.status).toBe('paused');
    expect(await ingest([reviewFixture()], newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901345`), {})).toBe(0);
    const saved = (await db.records.toArray())[0]!;
    expect(await db.records.count()).toBe(1);
    expect(saved.taskId).toBe('4010128');
    expect(saved.detail).toMatchObject({ status: 'complete', verified: true, via: 'devtools', data: { id: 7901345, review: { annotationScore: 4, status: 'APPROVED' } } });
    expect(saved.detail?.errors.at(-1)?.status).toBe(403);
    expect(summarizeReviews([saved])).toMatchObject({ collected: 1, failed: 0, reviewed: 1, scored: 1, average: 4 });
    const cached = await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    expect(cached.diagnostics).toMatchObject({ skippedCache: 1, queued: 0, started: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('persists website mode for resume and enforces a single paced navigation with no automatic retries', async () => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockImplementation(async id => success(id));
    const collector: AnnotationDetailCollector = new AnnotationDetailCollector({
      method: 'website', transport, exclusive, onProgress: run => { if (run.completed === 1) collector.pause(); },
    });
    const paused = await collector.start({ config: { concurrency: 3, delayMs: 500, maxRetries: 3 } });
    expect(paused).toMatchObject({ method: 'website', status: 'paused', config: { concurrency: 1, delayMs: 1500, maxRetries: 0 } });
    await expect(new AnnotationDetailCollector({ transport, exclusive }).start({ resume: paused })).rejects.toThrow('saved collection method');
    const resumed = await new AnnotationDetailCollector({ method: 'website', transport, exclusive }).start({ resume: paused });
    expect(resumed.status).toBe('complete');
    expect(transport.mock.calls.map(call => call[0])).toEqual([7901345, 7901346]);
  });
  it('pauses website navigation on a native redirect and persists its Retry-After cooldown', async () => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockResolvedValue({
      kind: 'error', reason: 'execution', status: 302, started: true, retryAfterMs: 120_000, message: 'The website detail request redirected.',
    });
    const collector = new AnnotationDetailCollector({ method: 'website', transport, exclusive });
    const run = await collector.start({ config });
    expect(run.status).toBe('paused');
    expect(run.notBefore).toBeGreaterThan(Date.now() + 119_000);
    expect(run.diagnostics).toMatchObject({ started: 1, completed: 1, httpCodes: { '302': 1 }, failed: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(collector.start({ config })).rejects.toThrow('Retry-After');
  });
  it('pauses and resumes from saved successful records, including after a new connection', async () => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockImplementation(async id => success(id));
    const collector: AnnotationDetailCollector = new AnnotationDetailCollector({ transport, exclusive, onProgress: run => { if (run.completed === 1) collector.pause(); } });
    const paused = await collector.start({ config });
    expect(paused.status).toBe('paused');
    const connection = new AnalyticsDB();
    expect((await connection.records.where('id').equals('7901345').first())?.detail?.data?.review.annotationScore).toBe(4);
    connection.close();
    const resumed = await new AnnotationDetailCollector({ transport, exclusive }).start({ resume: paused });
    expect(resumed.status).toBe('complete');
    expect(transport.mock.calls.map(call => call[0])).toEqual([7901345, 7901346]);
  });
  it('cancels an active request without marking an unknown review as missing or failed', async () => {
    await seed();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const transport: DetailTransport = (_id, signal) => new Promise((_resolve, reject) => {
      started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const collector = new AnnotationDetailCollector({ transport, exclusive });
    const running = collector.start({ config });
    await ready;
    await expect(collector.start({ config })).rejects.toThrow('already running');
    collector.cancel();
    expect((await running).status).toBe('cancelled');
    const saved = (await db.records.toArray())[0]!;
    expect(saved.detail?.status).toBe('pending');
    expect(summarizeReviews([saved])).toMatchObject({ failed: 0, pending: 1, missingReviews: 0, average: null });
  });
  it('resumes refreshes by successful run identity rather than trusting cached wall-clock timestamps', async () => {
    await seed([7901345, 7901346]);
    const transport = vi.fn<DetailTransport>().mockImplementation(async id => success(id));
    await new AnnotationDetailCollector({ transport, exclusive }).start({ config });
    await db.records.toCollection().modify(record => { record.detail!.fetchedAt = '2999-01-01T00:00:00.000Z'; });
    const collector: AnnotationDetailCollector = new AnnotationDetailCollector({ transport, exclusive, onProgress: run => { if (run.completed === 1) collector.pause(); } });
    const paused = await collector.start({ config, refresh: true });
    expect(paused.status).toBe('paused');
    await ingest([reviewFixture(7901345)], newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901345`), {});
    expect((await db.records.where('id').equals('7901345').first())?.detail?.completedRunId).toBe(paused.id);
    await new AnnotationDetailCollector({ transport, exclusive }).start({ resume: paused });
    expect(transport.mock.calls.map(call => call[0])).toEqual([7901345, 7901346, 7901345, 7901346]);
  });
  it('limits concurrency and does not request mismatched task or undiscovered IDs', async () => {
    await seed([7901345, 7901346, 7901347]);
    let active = 0, max = 0;
    const transport = vi.fn<DetailTransport>().mockImplementation(async id => {
      active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 550)); active--;
      return success(id);
    });
    await new AnnotationDetailCollector({ transport, exclusive }).start({ config: { ...config, concurrency: 2 } });
    expect(max).toBe(2);
    expect(transport.mock.calls.map(call => call[0]).sort()).toEqual([7901345, 7901346, 7901347]);
  });
  it('deduplicates LinkedIn annotations by annotation ID across list project variations', async () => {
    await seed();
    await ingest([fixture('7901345', { projectId: 'updated-project' })], newSource('import', sourceUrl), {});
    expect(await db.records.count()).toBe(1);
    const bad = vi.fn<DetailTransport>().mockResolvedValue(success(4010128));
    await new AnnotationDetailCollector({ transport: bad, exclusive }).start({ config });
    expect((await db.records.toArray())[0]?.detail?.status).toBe('failed');
    expect((await db.records.toArray())[0]?.detail?.data).toBeNull();
  });
  it('round-trips reviews through JSON exports and snapshots without duplicating annotations', async () => {
    await seed();
    await new AnnotationDetailCollector({ transport: async id => success(id), exclusive }).start({ config });
    await saveSnapshot('Review baseline', {});
    const snapshot = (await db.snapshots.toArray())[0]!;
    const json = exportRecords(await db.records.toArray(), 'json');
    await clearCurrent();
    await importData(json, {});
    expect(reviewScore((await db.records.toArray())[0]!)).toBe(4);
    await restoreSnapshot(snapshot, true, {});
    expect(reviewScore((await db.records.toArray())[0]!)).toBe(4);
    expect(await db.records.count()).toBe(1);
  });
  it('migrates schema 1 IDs and epoch timestamps without discarding legacy records', async () => {
    const name = `review-migration-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({ records: '&key, id, projectId, state, createdAt, source.id', sources: '&id, collectedAt, method', snapshots: '&id, createdAt' });
    const old = normalize(fixture('7901345', { createdAt: 1793478535000, taskId: 4010128 }), newSource('import', sourceUrl))!;
    await legacy.table('records').put({ ...old, rawPayload: reviewFixture(), key: 'old-key', detail: undefined, taskId: undefined, createdAt: null });
    legacy.close();
    const upgraded = new AnalyticsDB(name);
    const saved = (await upgraded.records.toArray())[0]!;
    expect(saved.taskId).toBe('4010128');
    expect(saved.createdAt).toBe(new Date(1793478535000).toISOString());
    expect(saved.key).toBe(JSON.stringify([LINKEDIN_ORIGIN, null, '7901345']));
    expect(saved.detail?.data?.review.annotationScore).toBe(4);
    expect(JSON.stringify(saved)).not.toContain('Synthetic fixture identity');
    upgraded.close(); await Dexie.delete(name);
  });
  it('repairs persisted schema 2 false-complete caches without deleting real successful no-review details', async () => {
    const name = `review-cache-repair-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(2).stores({
      records: '&key, id, taskId, projectId, state, createdAt, source.id, detail.status',
      sources: '&id, collectedAt, method', snapshots: '&id, createdAt', reviewRuns: '&id, startedAt, status',
    });
    const bad = normalize(reviewFixture(7901345, { currentVersionReview: null }), newSource('devtools', sourceUrl))!;
    bad.detail = { ...detailCollection(parseAnnotationDetail(reviewFixture(7901345, { currentVersionReview: null })), 'import'), verified: undefined };
    const good = row(7901346, { currentVersionReview: null });
    good.detail = { ...good.detail!, verified: undefined, via: 'session', completedRunId: 'successful-run' };
    await legacy.table('records').bulkPut([bad, good]);
    await legacy.table('snapshots').put({ id: 'legacy', records: [bad], schemaVersion: 2 });
    legacy.close();
    const upgraded = new AnalyticsDB(name);
    const repaired = await upgraded.records.get(bad.key);
    expect(repaired?.detail).toMatchObject({ status: 'pending', data: null, verified: false });
    expect(hasCachedDetail((await upgraded.records.get(good.key))!)).toBe(true);
    expect((await upgraded.snapshots.get('legacy'))?.records[0]?.detail?.data).toBeNull();
    upgraded.close(); await Dexie.delete(name);
  });
});
