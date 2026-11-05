import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { annotationPaymentCoverage, batchName, cents, financialProjection, financialSummary, normalizeFinancialTime, observedBatchEarnings, parseFinancialNotes, reconcileFinancialBatches } from '../src/core/finance';
import { clearFinancialData, ingestFinancialTime, saveFinancialDom, saveFinancialMapping } from '../src/core/finance-storage';
import { AnalyticsDB, db, newSource } from '../src/core/storage';
import { normalize } from '../src/core/parsing';
import { readGreenlightDashboard, previousGreenlightWeek } from '../src/collectors/greenlight';
import { FinancialBatchReconciliation, FinancialSummary, filterPayments, financialCsv } from '../src/ui/Financials';
import { emptyFinancialFilters, useApp } from '../src/ui/store';
import { fixture } from './fixtures';
import { financeFixture, financeUrl, greenlightMarkup } from './finance-fixtures';
import Dexie from 'dexie';
import { reviewFixture } from './review-fixtures';
import { batchJoinKey, extractBatchCatalog, mergeBatchDescriptors } from '../src/core/batches';
import { recoverRecordBatch } from '../src/core/review';
import { filterRecords } from '../src/core/analytics';
import { emptyFilters } from '../src/core/model';

beforeEach(async () => { await clearFinancialData(); });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('financial accounting and persistent cache', () => {
  it('counts processed/pending money in exact cents and correction counts as deltas without retaining account metadata', () => {
    const { payments } = normalizeFinancialTime(financeFixture(), financeUrl);
    expect(financialSummary(payments)).toMatchObject({ paidCents: 32500, pendingCents: 4334,
      paidAnnotations: 15, pendingAnnotations: 2, pendingReviews: 1, unknownCounts: 0 });
    expect(JSON.stringify(payments)).not.toContain('fixture-user-not-retained');
    expect(JSON.stringify(payments)).not.toContain('createdOnIp');
    expect(cents('476.67') + cents('216.67') + cents('21.67')).toBe(71501);
    expect(() => cents('21.667')).toThrow('two decimal');
  });
  it('rejects mismatched supplier/range and malformed amounts atomically, and preserves newer updates across reimport and DB reopen', async () => {
    await ingestFinancialTime(financeFixture(), financeUrl);
    await ingestFinancialTime(financeFixture(), financeUrl);
    expect(await db.payments.count()).toBe(3);
    const older = financeFixture();
    older.deliverables[0]!.amount = 1;
    older.deliverables[0]!.updatedAt = '2026-10-01T00:00:00';
    await ingestFinancialTime(older);
    expect((await db.payments.get(JSON.stringify(['S-fixture', 'delivery-a'])))?.amountCents).toBe(26000);
    await expect(ingestFinancialTime(financeFixture({ organizationId: 'wrong-supplier' }), financeUrl)).rejects.toThrow('does not match');
    const invalid = financeFixture();
    invalid.deliverables[1]!.amount = 0.001;
    await expect(ingestFinancialTime(invalid)).rejects.toThrow('two decimal');
    expect(await db.payments.count()).toBe(3);
    const reopened = new AnalyticsDB();
    try { expect(financialSummary(await reopened.payments.toArray()).paidCents).toBe(32500); }
    finally { reopened.close(); }
  });
  it('keeps monetary adjustments with unknown notes, rejects invalid dates, and never double-counts unrecognized corrections', () => {
    expect(parseFinancialNotes('TAG|Correction unknown format: 12 tasks')).toMatchObject({ batches: [], warning: expect.stringContaining('Unrecognized correction') });
    expect(parseFinancialNotes('Correction for incorrect payment in batch A (Paid: 9 Att, 2 Rev | Actual: 6 Att, 1 Rev)').batches[0]).toMatchObject({ annotations: -3, reviews: -1 });
    const value = financeFixture();
    value.deliverables[1]!.notes = 'TAG|Unrecognized count text';
    const summary = financialSummary(normalizeFinancialTime(value).payments);
    expect(summary).toMatchObject({ paidCents: 32500, paidAnnotations: 12, unknownCounts: 1 });
    expect(() => normalizeFinancialTime(financeFixture({ start: '2026-02-30T00:00:00' }))).toThrow('Invalid Greenlight');
  });
  it('estimates only explicitly mapped submitted annotations, subtracts paid and pending counts once, and excludes conflicting counts', async () => {
    const { payments } = normalizeFinancialTime(financeFixture());
    const records = Array.from({ length: 14 }, (_, index) => normalize(fixture(String(index + 1), { iterationId: 'iteration-fixture' }),
      newSource('import', 'https://www.linkedin.com/ai-trainer/api/list'))!);
    const mapping = { organizationId: 'S-fixture', engagementId: 'engagement-fixture', tag: 'PROJECT-FIXTURE', batch: 'Batch A',
      dimension: 'iteration' as const, annotationScope: 'iteration-fixture', rateCents: 2167 };
    await saveFinancialMapping(mapping);
    const mappings = await db.financialMappings.toArray();
    expect(financialProjection(payments, [...records, records[0]!], mappings)[0]).toMatchObject({ submitted: 14, paid: 9, pending: 2, remaining: 3, projectedCents: 6501 });
    expect(financialProjection(payments, records.slice(0, 2), mappings)[0]).toMatchObject({ remaining: null, projectedCents: null });
    await expect(saveFinancialMapping({ ...mapping, annotationScope: 'another-iteration' })).rejects.toThrow('already has');
    await expect(saveFinancialMapping({ ...mapping, dimension: 'project', batch: 'Batch B', annotationScope: 'project-fixture' })).rejects.toThrow('one mapping level');
  });
  it('filters ledger and exports its actual amounts, count uncertainty and formula-safe notes', () => {
    const { payments } = normalizeFinancialTime(financeFixture());
    const pending = filterPayments(payments, { ...emptyFinancialFilters, status: 'pending', search: 'Batch A' });
    expect(pending).toHaveLength(1);
    pending[0]!.notes = '=SUM(A1:A3)';
    expect(financialCsv(pending)).toContain('"43.34","Pending"');
    expect(financialCsv(pending)).toContain("\"'=SUM(A1:A3)\"");
  });
  it('upgrades an existing schema-3 annotation database without replacing its records', async () => {
    const name = `financial-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(3).stores({
      records: '&key, id, taskId, projectId, state, createdAt, source.id, detail.status',
      sources: '&id, collectedAt, method', snapshots: '&id, createdAt', reviewRuns: '&id, startedAt, status',
    });
    const record = normalize(fixture('existing-annotation'), newSource('import'))!;
    await legacy.table('records').put(record);
    legacy.close();
    const upgraded = new AnalyticsDB(name);
    try {
      await upgraded.open();
      expect(await upgraded.records.get(record.key)).toMatchObject({ id: record.id });
      expect(await upgraded.payments.count()).toBe(0);
      expect(upgraded.verno).toBe(6);
    } finally { upgraded.close(); await Dexie.delete(name); }
  });
  it('recovers surviving schema-4 batch metadata locally, including snapshots, without invalidating verified details', async () => {
    const name = `batch-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(4).stores({
      records: '&key, id, taskId, projectId, state, createdAt, source.id, detail.status',
      sources: '&id, collectedAt, method', snapshots: '&id, createdAt', reviewRuns: '&id, startedAt, status',
      payments: '&key, organizationId, engagementId, date, status', financialPeriods: '&key, capturedAt',
      financialDom: '&key, capturedAt', financialMappings: '&key',
    });
    const record = normalize(reviewFixture(), newSource('import', 'https://www.linkedin.com/ai-trainer/api/list'))!;
    delete record.detail!.data!.pipelineName;
    delete record.detail!.data!.pipelineStageType;
    record.pipeline = { id: 7001, name: 'Batch A' };
    record.iteration = { id: 3188053, name: 'Attempt' };
    await legacy.table('records').put(record);
    await legacy.table('snapshots').put({ id: 'snapshot', name: 'Existing', schemaVersion: 2, records: [record], sources: [], mappings: {} });
    legacy.close();
    const upgraded = new AnalyticsDB(name);
    try {
      const saved = await upgraded.records.get(record.key);
      expect(saved?.detail).toMatchObject({ verified: true, fetchedAt: record.detail!.fetchedAt,
        data: { pipelineName: 'Batch A', pipelineStageType: 'ATTEMPT', review: { annotationScore: 4 } } });
      expect((await upgraded.snapshots.get('snapshot'))?.records[0]!.detail?.data?.pipelineName).toBe('Batch A');
    } finally { upgraded.close(); await Dexie.delete(name); }
  });
  it('upgrades schema-5 records and payments to persisted shared keys using only surviving pipeline catalogs', async () => {
    const name = `join-upgrade-${crypto.randomUUID()}`, legacy = new Dexie(name);
    legacy.version(5).stores({
      records: '&key, id, taskId, projectId, state, createdAt, source.id, detail.status',
      sources: '&id, collectedAt, method', snapshots: '&id, createdAt', reviewRuns: '&id, startedAt, status',
      payments: '&key, organizationId, engagementId, date, status', financialPeriods: '&key, capturedAt',
      financialDom: '&key, capturedAt', financialMappings: '&key',
    });
    const label = 'Webapp Preference - 320 - Set AF - 2026-10-31';
    const record = normalize(reviewFixture(1, { projectId: 77, iterationId: 101, pipeline: { id: 901 } }),
      newSource('import', 'https://www.linkedin.com/ai-trainer/api/list'))!;
    record.rawPayload = { projectId: 77, project: { id: 77, pipelines: [{ id: 901, name: label, stages: [{ iterationId: 101, type: 'ATTEMPT' }] }] } };
    const payment = normalizeFinancialTime(financeFixture()).payments[0]!;
    payment.batches = [{ name: 'Webapp Preference - Set AF - 2026-10-31', annotations: 1, reviews: 0, correction: false }];
    await legacy.table('records').put(record);
    await legacy.table('payments').put(payment);
    legacy.close();
    const upgraded = new AnalyticsDB(name);
    try {
      const saved = (await upgraded.records.get(record.key))!;
      const paid = (await upgraded.payments.toArray())[0]!;
      expect(saved.batchKey).toBe(paid.batches[0]!.batchKey);
      expect(saved.detail).toMatchObject({ verified: true, fetchedAt: record.detail!.fetchedAt,
        data: { pipelineName: label, pipelineStageType: 'ATTEMPT', review: { annotationScore: 4 } } });
      expect(await upgraded.records.where('batchKey').equals(saved.batchKey!).count()).toBe(1);
      expect(annotationPaymentCoverage([saved], [paid]).get(saved.key)).toMatchObject({ state: 'paid', remaining: 0 });
    } finally { upgraded.close(); await Dexie.delete(name); }
  });
});

describe('automatic cached batch reconciliation', () => {
  const batch = 'Webapp Preference - Set AF - 2026-10-31';
  const cached = (id: number, name = 'Webapp Preference - 320 - Set AF - 2026-10-31', type = 'ATTEMPT', overrides = {}) =>
    normalize(reviewFixture(id, { pipeline: { id: 7001, name }, pipelineStage: { id: 7101, type }, ...overrides }),
      newSource('import', 'https://www.linkedin.com/ai-trainer/api/list'))!;
  const ledger = () => {
    const payload = financeFixture();
    payload.deliverables[0]!.notes = `TAG|UI Berry 3R: ${batch}- Att: 1, Rev: 1;`;
    payload.deliverables[1]!.notes = `TAG|Correction for incorrect payment in batch ${batch} (Paid: 1 Att, 1 Rev | Actual: 2 Att, 1 Rev)`;
    payload.deliverables[2]!.notes = `TAG|${batch}- Att: 1, Rev: 0;`;
    return normalizeFinancialTime(payload).payments;
  };
  it('matches exact family/Set/date and reconciles attempt/review counts and corrections without assigning paid IDs', () => {
    const records = [cached(1), cached(2), cached(3), cached(4), cached(5, undefined, 'REVIEW')];
    const result = reconcileFinancialBatches(ledger(), [...records, records[0]!]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ status: 'matched', pipelineId: '7001', cachedAttempts: 4, cachedReviews: 1,
      paidAttempts: 2, pendingAttempts: 1, paidReviews: 1, pendingReviews: 0, unaccountedAttempts: 1, uncertain: false });
    expect(result.rows[0]).not.toHaveProperty('paidAnnotationIds');
    expect(batchName('  Webapp Preference - 320 - Set AF - 2026-10-31  ')).toBe(batchName(batch));
    expect(batchName('Preference 320 - Set AF - 2026-10-31')).not.toBe(batchName('Preference - Set AF - 2026-10-31'));
    expect(reconcileFinancialBatches(ledger(), [cached(1, 'Webapp Preference - Set K - 2026-10-31')]).rows[0]!.status).toBe('unmatched');
    expect(reconcileFinancialBatches(ledger(), [cached(1, 'Webapp Preference - Set AF - 2026-10-30')]).rows[0]!.status).toBe('unmatched');
  });
  it('refuses ambiguous scopes and uncertain counts while exposing missing metadata and unknown work types', () => {
    const payments = ledger();
    expect(reconcileFinancialBatches(payments, [cached(1), cached(2, undefined, 'ATTEMPT', { projectId: 9999 })]).rows[0])
      .toMatchObject({ status: 'ambiguous', unaccountedAttempts: null });
    const otherScope = { ...payments[0]!, key: 'other', organizationId: 'another-supplier' };
    expect(reconcileFinancialBatches([...payments, otherScope], [cached(1)]).rows.every(row => row.status === 'ambiguous')).toBe(true);
    expect(reconcileFinancialBatches(payments, [cached(1)]).rows[0]).toMatchObject({ status: 'matched', uncertain: true, unaccountedAttempts: null });
    const unknown = cached(2, undefined, 'FUTURE_STAGE');
    const missing = cached(3, '');
    const result = reconcileFinancialBatches(payments, [cached(1), unknown, missing]);
    expect(result.missingMetadata).toBe(1);
    expect(result.rows[0]).toMatchObject({ unknownWorkType: 1, unaccountedAttempts: null });
    payments[0]!.countWarning = 'Unknown notes';
    expect(reconcileFinancialBatches(payments, Array.from({ length: 5 }, (_, id) => cached(id + 1))).rows[0]!.unaccountedAttempts).toBeNull();
  });
  it('renders automatic batch counts from cache and explicitly explains unavailable metadata', () => {
    useApp.setState({ payments: ledger(), records: [cached(1), cached(2), cached(3), cached(4), cached(5, undefined, 'REVIEW')] });
    render(<FinancialBatchReconciliation />);
    const table = screen.getByRole('table', { name: 'Automatic financial batch matches' });
    expect(table).toHaveTextContent('Matched · project 989007 · pipeline 7001');
    expect(table).toHaveTextContent('4 / 1');
    expect(screen.getByText(/No tasks are refreshed by this view/)).toBeVisible();
  });
  it('derives the same-batch paid rate and rounds the final remaining estimate, without counting pending amounts twice', () => {
    const payload = financeFixture();
    payload.deliverables = [
      { ...payload.deliverables[0]!, amount: 10, notes: `TAG|${batch}- Att: 3, Rev: 0;` },
      { ...payload.deliverables[2]!, amount: 6.66, notes: `TAG|${batch}- Att: 2, Rev: 0;` },
    ];
    const { payments, period } = normalizeFinancialTime(payload);
    const records = Array.from({ length: 7 }, (_, index) => cached(index + 1));
    const observed = observedBatchEarnings(payments, reconcileFinancialBatches(payments, [...records, records[0]!]));
    expect(observed).toMatchObject({ remainingCents: 1333, unaccountedCents: 667, availableEstimates: 1, unavailableEstimates: 0 });
    expect(observed.rows[0]!.attempts).toMatchObject({ paidAmountCents: 1000, paidCount: 3, remainingCount: 4,
      unaccountedCount: 2, remainingCents: 1333, unaccountedCents: 667, reason: null });
    useApp.setState({ payments, records, financialPeriods: [period], financialDom: [], financialMappings: [] });
    render(<FinancialSummary />);
    expect(screen.getByText('Remaining earnings estimate (observed batch rates)').closest('article')).toHaveTextContent('$13.33');
    expect(screen.getByText('Pending + unbilled estimate (observed rates)').closest('article')).toHaveTextContent('$13.33');
    expect(screen.getByText('Pending payments').closest('article')).toHaveTextContent('$6.66');
  });
  it('weights attributable paid deliverables within a batch, keeps review rates separate and uses positive correction deltas', () => {
    const payments = ledger();
    payments[0]!.batches[0]!.reviews = 0;
    payments[0]!.amountCents = 1000;
    payments[1]!.amountCents = 2000;
    const review = { ...payments[0]!, key: 'review-rate', id: 'review-rate', amountCents: 500,
      batches: [{ name: batch, annotations: 0, reviews: 1, correction: false }] };
    const records = [cached(1), cached(2), cached(3), cached(4), cached(5, undefined, 'REVIEW'), cached(6, undefined, 'REVIEW')];
    const rows = [...payments, review];
    const observed = observedBatchEarnings(rows, reconcileFinancialBatches(rows, records));
    expect(observed.rows[0]!.attempts).toMatchObject({ paidCount: 2, paidAmountCents: 3000, remainingCount: 2, remainingCents: 3000 });
    expect(observed.rows[0]!.reviews).toMatchObject({ paidCount: 1, paidAmountCents: 500, remainingCount: 1, remainingCents: 500 });
    expect(observed.remainingCents).toBe(3500);
  });
  it('does not allocate mixed-batch or mixed-work payments, borrow another batch rate, or estimate uncertain matches', () => {
    const payments = ledger().slice(0, 1);
    const records = [cached(1), cached(2), cached(3, undefined, 'REVIEW')];
    const project = () => observedBatchEarnings(payments, reconcileFinancialBatches(payments, records));
    expect(project().rows[0]!.attempts).toMatchObject({ remainingCents: null, paidCount: 0, reason: expect.stringContaining('No attributable') });
    payments[0]!.batches[0]!.reviews = 0;
    payments[0]!.batches.push({ name: 'Another batch', annotations: 1, reviews: 0, correction: false });
    expect(project().rows.find(row => row.batch === batch)!.attempts.remainingCents).toBeNull();
    payments[0]!.batches.pop();
    const ambiguous = [...records, cached(4, undefined, 'ATTEMPT', { projectId: 9999 })];
    expect(observedBatchEarnings(payments, reconcileFinancialBatches(payments, ambiguous)).rows[0]!.attempts)
      .toMatchObject({ remainingCents: null, reason: 'Uncertain batch reconciliation' });
    const unseen = [cached(5, 'Unseen batch', 'ATTEMPT', { pipeline: { id: 9000, name: 'Unseen batch' } })];
    expect(observedBatchEarnings(payments, reconcileFinancialBatches(payments, [...records, ...unseen])).rows.find(row => row.batch === 'Unseen batch')!.attempts.remainingCents).toBeNull();
  });
  it('rejects observed earnings outside exact-cent limits rather than overflowing or silently rounding', () => {
    const payment = ledger()[0]!;
    payment.amountCents = Number.MAX_SAFE_INTEGER;
    payment.batches[0]!.reviews = 0;
    const payments = [payment], records = [cached(1), cached(2), cached(3)];
    expect(() => observedBatchEarnings(payments, reconcileFinancialBatches(payments, records))).toThrow('exact-cent range');
  });
  it('includes completed cache-only batches and keeps valid attempt counts when review counts cannot reconcile', () => {
    const records = [cached(1), cached(2), cached(3), cached(4),
      cached(5, 'Unbilled batch', 'ATTEMPT', { pipeline: { id: 8001, name: 'Unbilled batch' } }),
      cached(6, 'Unbilled batch', 'ATTEMPT', { pipeline: { id: 8001, name: 'Unbilled batch' } }),
      cached(7, 'Unbilled batch', 'REVIEW', { pipeline: { id: 8001, name: 'Unbilled batch' } })];
    const result = reconcileFinancialBatches(ledger(), [...records, records[5]!]);
    expect(result.rows[0]).toMatchObject({ status: 'matched', uncertain: true, unaccountedAttempts: 1, unaccountedReviews: null });
    expect(result.rows[1]).toMatchObject({ status: 'no-payment', cachedAttempts: 2, cachedReviews: 1,
      paidAttempts: 0, pendingAttempts: 0, unaccountedAttempts: 2, unaccountedReviews: 1 });
    expect(result).toMatchObject({ unaccountedAttempts: 3, unaccountedReviews: 1 });
    const payments = ledger();
    payments[0]!.countWarning = 'Unrecognized notes could cover the missing batch';
    expect(reconcileFinancialBatches(payments, records).unaccountedAttempts).toBe(0);
    useApp.setState({ payments: ledger(), records, financialPeriods: [normalizeFinancialTime(financeFixture()).period], financialDom: [], financialMappings: [] });
    render(<FinancialSummary />);
    expect(screen.getByText('Pending annotation tasks').closest('article')).toHaveTextContent('1');
    expect(screen.getByText('Completed attempts not in ledger (estimate)').closest('article')).toHaveTextContent('3');
    expect(screen.getByText('Total pending attempts (estimate)').closest('article')).toHaveTextContent('4');
    expect(screen.getByText('Pending payments').closest('article')).toHaveTextContent('$43.34');
  });
  it('shows cache-only workload without inventing zero paid/pending money before collection', () => {
    useApp.setState({ payments: [], records: [cached(1), cached(2)], financialPeriods: [], financialDom: [], financialMappings: [] });
    render(<FinancialSummary />);
    expect(screen.getByText('Paid earnings').closest('article')).toHaveTextContent('Not collected');
    expect(screen.getByText('Pending payments').closest('article')).toHaveTextContent('Not collected');
    expect(screen.getByText('Completed attempts not in ledger (estimate)').closest('article')).toHaveTextContent('2');
    expect(screen.getByText(/No financial ledger captured/)).toBeVisible();
  });
  it('joins saved normalized keys and filters paid, pending and partial batch coverage with remaining work including pending deliverables', () => {
    const records = [cached(1), cached(2), cached(3), cached(4), cached(5, undefined, 'REVIEW')];
    const payments = ledger();
    expect(records[0]!.batchKey).toBe(payments[0]!.batches[0]!.batchKey);
    expect(reconcileFinancialBatches(payments, records)).toMatchObject({ remainingToPayAttempts: 2 });
    expect(annotationPaymentCoverage(records, payments).get(records[0]!.key)).toMatchObject({ state: 'partial', paid: 2, remaining: 2 });
    const fullyPaid = payments.map(payment => ({ ...payment, batches: payment.batches.map(value => ({ ...value,
      annotations: payment.status === 4 ? payment.id === 'delivery-a' ? 3 : 1 : 0 })) }));
    expect(annotationPaymentCoverage(records, fullyPaid).get(records[0]!.key)).toMatchObject({ state: 'paid', remaining: 0 });
    expect(annotationPaymentCoverage(records, []).get(records[0]!.key)).toMatchObject({ state: 'pending', remaining: 4 });
    expect(filterRecords(records, { ...emptyFilters, paymentState: 'remaining' }, payments).map(record => record.id)).toEqual(['1', '2', '3', '4']);
    expect(filterRecords(records, { ...emptyFilters, paymentState: 'paid' }, payments).map(record => record.id)).toEqual(['5']);
  });
  it('does not recover a join from contradictory pipeline names or another project and keeps Set/date identity distinct', () => {
    const record = cached(1, undefined, 'ATTEMPT', { projectId: 77, pipeline: { id: 901 }, pipelineStage: undefined, iterationId: 101 });
    const catalog = (name: string) => extractBatchCatalog({ projectId: 77, project: { id: 77, pipelines: [
      { id: 901, name, stages: [{ iterationId: 101, type: 'ATTEMPT' }] },
    ] } }).batches;
    const conflict = mergeBatchDescriptors([...catalog('Preference - Set AF - 2026-10-31'), ...catalog('Preference - Set AG - 2026-10-31')]);
    expect(recoverRecordBatch(record, conflict).batchKey).toBeNull();
    expect(recoverRecordBatch({ ...record, projectId: 'another-project' }, catalog('Preference - Set AF - 2026-10-31')).batchKey).toBeNull();
    const label = 'Preference - Set AF - 2026-10-31';
    const named = cached(2, undefined, 'ATTEMPT', { projectId: 77, iterationId: 101, pipeline: null });
    named.detail!.data!.pipelineName = label;
    named.pipeline = { name: label };
    named.batchKey = batchJoinKey(label);
    expect(recoverRecordBatch(named, catalog(label)).pipeline).toMatchObject({ id: '901', name: label });
    expect(batchJoinKey('Preference - 320 - Set AF - 2026-10-31')).toBe(batchJoinKey(' preference - Set AF - 2026-10-31 '));
    expect(batchJoinKey('Preference - Set AF - 2026-10-31')).not.toBe(batchJoinKey('Preference - Set AF - 2026-10-30'));
  });
});

describe('authorized rendered Greenlight collection', () => {
  it('reads the provided DOM structure without profile, manager or page-token access and permits only the observed previous-week control', async () => {
    vi.stubGlobal('location', new URL('https://portal.greenlight.ai/dashboard'));
    document.body.innerHTML = greenlightMarkup();
    const result = readGreenlightDashboard();
    expect(result.rates).toEqual([{ name: 'AI Trainer fixture', cents: 2167, unit: 'project' }]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ amountCents: 32500, status: 'Processed' });
    expect(JSON.stringify(result)).not.toContain('manager-not-retained');
    await saveFinancialDom(result);
    const click = vi.fn();
    document.getElementById('previous')!.addEventListener('click', click);
    expect(previousGreenlightWeek()).toContain('Oct 12th');
    expect(click).toHaveBeenCalledOnce();
    document.querySelector('[class*="container_data__"]')!.remove();
    expect(readGreenlightDashboard).toThrow('Expand the Deliverables');
    vi.stubGlobal('location', new URL('https://example.com/dashboard'));
    expect(readGreenlightDashboard).toThrow('not the authorized');
  });
  it('uses DOM as an explicitly partial fallback, then API as truth without adding the same visible money twice', async () => {
    vi.stubGlobal('location', new URL('https://portal.greenlight.ai/dashboard'));
    document.body.innerHTML = greenlightMarkup();
    await saveFinancialDom(readGreenlightDashboard());
    document.body.innerHTML = '';
    useApp.setState({ payments: [], financialPeriods: [], financialDom: await db.financialDom.toArray(), financialMappings: [], records: [] });
    const { rerender } = render(<FinancialSummary />);
    expect(screen.getByText('Paid earnings').closest('article')).toHaveTextContent('$325.00');
    expect(screen.getByText('Paid annotation tasks').closest('article')).toHaveTextContent('Not available');
    await ingestFinancialTime(financeFixture());
    useApp.setState({ payments: await db.payments.toArray(), financialPeriods: await db.financialPeriods.toArray() });
    rerender(<FinancialSummary />);
    expect(screen.getByText('Paid earnings').closest('article')).toHaveTextContent('$325.00');
    expect(screen.getByText('Paid annotation tasks').closest('article')).toHaveTextContent('15');
    expect(screen.getByText('Pending payments').closest('article')).toHaveTextContent('$43.34');
    const open = vi.fn();
    rerender(<FinancialSummary onOpen={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Financials' }));
    expect(open).toHaveBeenCalledOnce();
  });
});
