import { z } from 'zod';
import type { AnnotationRecord } from './model';
import { redact } from './privacy';
import { annotationBatchMetadata, LINKEDIN_ORIGIN } from './review';
import { batchJoinKey } from './batches';

export const GREENLIGHT_PORTAL = 'https://portal.greenlight.ai';
export const GREENLIGHT_API = 'https://app.greenlight.ai';
const id = z.string().trim().min(1).max(200);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}T/).refine(value => {
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10);
});
export const financialTimeSchema = z.object({
  organizationId: id, start: date, end: date,
  deliverables: z.array(z.object({
    id, amount: z.number().finite(), date, status: z.number().int().nonnegative(),
    notes: z.string().max(2_000_000).nullish(), engagementId: id,
    engagementTag: z.object({ name: z.string().trim().min(1).max(500) }).nullish(),
    updatedAt: date.nullish(),
  })).max(10_000),
});
export interface FinancialBatch {
  name: string;
  batchKey?: string;
  annotations: number;
  reviews: number;
  correction: boolean;
}
export interface Payment {
  key: string;
  id: string;
  organizationId: string;
  engagementId: string;
  tag: string;
  date: string;
  amountCents: number;
  status: number;
  notes: string;
  batches: FinancialBatch[];
  countWarning: string | null;
  updatedAt: string | null;
  capturedAt: string;
}
export interface FinancialPeriod {
  key: string;
  organizationId: string;
  start: string;
  end: string;
  capturedAt: string;
  received: number;
}
export interface FinancialRate {
  name: string;
  cents: number;
  unit: string;
}
export interface FinancialDom {
  key: string;
  period: string;
  capturedAt: string;
  rates: FinancialRate[];
  rows: { engagement: string; date: string; status: string; amountCents: number; tag: string }[];
}
export interface FinancialMapping {
  key: string;
  organizationId: string;
  engagementId: string;
  tag: string;
  batch: string;
  dimension: 'iteration' | 'project';
  annotationScope: string;
  rateCents: number;
}
export function cents(value: number | string): number {
  const text = String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('USD amounts require at most two decimal places.');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('USD amount exceeds the supported exact-cent range.');
  return text.startsWith('-') ? -result : result;
}
export function usd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
}
export function batchName(value: string): string {
  return batchJoinKey(value);
}
export function reconcileFinancialBatches(payments: Payment[], records: AnnotationRecord[]) {
  type CachedBatch = { pipelineId: string | null; projectId: string | null; name: string; records: AnnotationRecord[] };
  const cached = new Map<string, CachedBatch>();
  const missingMetadata = new Set<string>();
  for (const record of records) {
    if (!record.source.url.startsWith(`${LINKEDIN_ORIGIN}/`) || record.state !== 'SUBMITTED') continue;
    const metadata = annotationBatchMetadata(record);
    if (!metadata.pipelineName || (!metadata.pipelineId && !record.iterationId)) { missingMetadata.add(record.id); continue; }
    const key = JSON.stringify([record.projectId, metadata.pipelineId ?? `iteration:${record.iterationId}`, batchName(metadata.pipelineName)]);
    const group = cached.get(key);
    if (group) group.records.push(record);
    else cached.set(key, { pipelineId: metadata.pipelineId, projectId: record.projectId, name: metadata.pipelineName, records: [record] });
  }
  const byName = new Map<string, CachedBatch[]>();
  for (const group of cached.values()) {
    const name = batchName(group.name);
    const groups = byName.get(name) ?? [];
    groups.push(group); byName.set(name, groups);
  }
  const ledger = new Map<string, { key: string; organizationId: string; engagementId: string; tag: string; batch: string; payments: Payment[] }>();
  for (const payment of payments) for (const batch of payment.batches) {
    const key = JSON.stringify([payment.organizationId, payment.engagementId, payment.tag, batchName(batch.name)]);
    const group = ledger.get(key);
    if (group) { if (!group.payments.includes(payment)) group.payments.push(payment); }
    else ledger.set(key, { key, organizationId: payment.organizationId, engagementId: payment.engagementId, tag: payment.tag, batch: batch.name, payments: [payment] });
  }
  const ledgerScopes = new Map<string, number>();
  for (const row of ledger.values()) ledgerScopes.set(batchName(row.batch), (ledgerScopes.get(batchName(row.batch)) ?? 0) + 1);
  const resultRow = (row: { key: string; organizationId: string | null; engagementId: string | null; tag: string | null; batch: string },
    matched: CachedBatch | null, status: 'matched' | 'ambiguous' | 'unmatched' | 'no-payment', candidateCount: number,
    counts: { paidAttempts: number; pendingAttempts: number; paidReviews: number; pendingReviews: number }, unknownNotes: boolean) => {
    const { paidAttempts, pendingAttempts, paidReviews, pendingReviews } = counts;
    const countRecords = (type: string | null) => new Set(matched?.records.filter(record => annotationBatchMetadata(record).workType === type).map(record => record.id)).size;
    const cachedAttempts = matched ? countRecords('ATTEMPT') : null, cachedReviews = matched ? countRecords('REVIEW') : null;
    const unknownWorkType = matched ? countRecords(null) : null;
    const attemptsUncertain = !matched || unknownNotes || !!unknownWorkType || paidAttempts < 0 || pendingAttempts < 0 ||
      paidAttempts + pendingAttempts > cachedAttempts!;
    const reviewsUncertain = !matched || unknownNotes || !!unknownWorkType || paidReviews < 0 || pendingReviews < 0 ||
      paidReviews + pendingReviews > cachedReviews!;
    return { ...row, status, candidateCount, pipelineId: matched?.pipelineId ?? null, projectId: matched?.projectId ?? null,
      iterationIds: matched ? [...new Set(matched.records.map(record => record.iterationId).filter((value): value is string => !!value))].sort() : [],
      cachedAttempts, cachedReviews, unknownWorkType, ...counts, uncertain: attemptsUncertain || reviewsUncertain,
      unaccountedAttempts: attemptsUncertain ? null : cachedAttempts! - paidAttempts - pendingAttempts,
      unaccountedReviews: reviewsUncertain ? null : cachedReviews! - paidReviews - pendingReviews,
      remainingToPayAttempts: attemptsUncertain ? null : cachedAttempts! - paidAttempts,
      remainingToPayReviews: reviewsUncertain ? null : cachedReviews! - paidReviews };
  };
  const rows = [...ledger.values()].map(row => {
    const candidates = byName.get(batchName(row.batch)) ?? [];
    const status = !candidates.length ? 'unmatched' : candidates.length > 1 || ledgerScopes.get(batchName(row.batch)) !== 1 ? 'ambiguous' : 'matched';
    const matched = status === 'matched' ? candidates[0]! : null;
    const count = (paid: boolean, dimension: 'annotations' | 'reviews') => exactSum(row.payments.filter(payment => (payment.status === 4) === paid)
      .flatMap(payment => payment.batches.filter(batch => batchName(batch.name) === batchName(row.batch)).map(batch => batch[dimension])));
    const paidAttempts = count(true, 'annotations'), pendingAttempts = count(false, 'annotations');
    const paidReviews = count(true, 'reviews'), pendingReviews = count(false, 'reviews');
    const unknownNotes = payments.some(payment => payment.organizationId === row.organizationId && payment.engagementId === row.engagementId &&
      payment.tag === row.tag && payment.countWarning);
    return resultRow({ key: row.key, organizationId: row.organizationId, engagementId: row.engagementId, tag: row.tag, batch: row.batch },
      matched, status, candidates.length, { paidAttempts, pendingAttempts, paidReviews, pendingReviews }, unknownNotes);
  });
  for (const [key, group] of cached) {
    if (ledgerScopes.has(batchName(group.name))) continue;
    rows.push(resultRow({ key: `cached:${key}`, organizationId: null, engagementId: null, tag: null, batch: group.name }, group, 'no-payment', 1,
      { paidAttempts: 0, pendingAttempts: 0, paidReviews: 0, pendingReviews: 0 }, payments.some(payment => !!payment.countWarning)));
  }
  return { rows, missingMetadata: missingMetadata.size,
    unaccountedAttempts: exactSum(rows.map(row => row.unaccountedAttempts ?? 0)),
    unaccountedReviews: exactSum(rows.map(row => row.unaccountedReviews ?? 0)),
    remainingToPayAttempts: exactSum(rows.map(row => row.remainingToPayAttempts ?? 0)),
    remainingToPayReviews: exactSum(rows.map(row => row.remainingToPayReviews ?? 0)) };
}
export interface AnnotationPaymentCoverage {
  state: 'paid' | 'pending' | 'partial' | 'unresolved' | 'not-submitted';
  label: string;
  batchKey: string | null;
  paid: number | null;
  remaining: number | null;
}
export function observedBatchEarnings(payments: Payment[], reconciliation: ReturnType<typeof reconcileFinancialBatches>) {
  const estimate = (amountCents: number, paidCount: number, count: number | null) => {
    if (count === null) return null;
    if (count === 0) return 0;
    if (!paidCount) return null;
    const denominator = BigInt(paidCount);
    const rounded = (BigInt(amountCents) * BigInt(count) + denominator / 2n) / denominator;
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Observed earnings estimate exceeds the supported exact-cent range.');
    return Number(rounded);
  };
  const rows = reconciliation.rows.map(row => {
    const work = (dimension: 'annotations' | 'reviews') => {
      const other = dimension === 'annotations' ? 'reviews' : 'annotations';
      const evidence = payments.filter(payment => payment.status === 4 && payment.amountCents > 0 && !payment.countWarning &&
        payment.organizationId === row.organizationId && payment.engagementId === row.engagementId && payment.tag === row.tag &&
        payment.batches.length === 1 && batchName(payment.batches[0]!.name) === batchName(row.batch) &&
        payment.batches[0]![dimension] > 0 && payment.batches[0]![other] === 0);
      const paidAmountCents = exactSum(evidence.map(payment => payment.amountCents));
      const paidCount = exactSum(evidence.map(payment => payment.batches[0]![dimension]));
      const remainingCount = dimension === 'annotations' ? row.remainingToPayAttempts : row.remainingToPayReviews;
      const unaccountedCount = dimension === 'annotations' ? row.unaccountedAttempts : row.unaccountedReviews;
      return { paidAmountCents, paidCount, evidenceDeliverables: evidence.length,
        rateCents: paidCount ? paidAmountCents / paidCount : null, remainingCount, unaccountedCount,
        remainingCents: estimate(paidAmountCents, paidCount, remainingCount),
        unaccountedCents: estimate(paidAmountCents, paidCount, unaccountedCount),
        reason: remainingCount === null ? 'Uncertain batch reconciliation' :
          remainingCount > 0 && !paidCount ? 'No attributable paid rate for this batch and work type' : null };
    };
    return { key: row.key, batch: row.batch, attempts: work('annotations'), reviews: work('reviews') };
  });
  const work = rows.flatMap(row => [row.attempts, row.reviews]);
  return { rows, remainingCents: exactSum(work.map(row => row.remainingCents ?? 0)),
    unaccountedCents: exactSum(work.map(row => row.unaccountedCents ?? 0)),
    availableEstimates: work.filter(row => row.remainingCount !== null && row.remainingCount > 0 && row.remainingCents !== null).length,
    unavailableEstimates: work.filter(row => row.remainingCount !== 0 && row.remainingCents === null).length };
}
export function annotationPaymentCoverage(records: AnnotationRecord[], payments: Payment[]): Map<string, AnnotationPaymentCoverage> {
  const reconciliation = reconcileFinancialBatches(payments, records);
  const byName = new Map<string, typeof reconciliation.rows>();
  for (const row of reconciliation.rows) {
    const key = batchName(row.batch), rows = byName.get(key) ?? [];
    rows.push(row); byName.set(key, rows);
  }
  return new Map(records.map(record => {
    const metadata = annotationBatchMetadata(record);
    const key = metadata.pipelineName ? batchName(metadata.pipelineName) : record.batchKey ?? null;
    let coverage: AnnotationPaymentCoverage = { state: 'unresolved', label: 'Batch payment unresolved', batchKey: key, paid: null, remaining: null };
    if (record.state !== 'SUBMITTED') coverage = { ...coverage, state: 'not-submitted', label: 'Not submitted' };
    else if (key && metadata.workType) {
      const candidates = (byName.get(key) ?? []).filter(row => row.projectId === record.projectId &&
        (metadata.pipelineId ? row.pipelineId === metadata.pipelineId : !!record.iterationId && row.iterationIds.includes(record.iterationId)));
      const row = candidates.length === 1 ? candidates[0] : null;
      if (row) {
        const remaining = metadata.workType === 'ATTEMPT' ? row.remainingToPayAttempts : row.remainingToPayReviews;
        const paid = metadata.workType === 'ATTEMPT' ? row.paidAttempts : row.paidReviews;
        if (remaining !== null) {
          const state = remaining === 0 && paid > 0 ? 'paid' : paid > 0 ? 'partial' : 'pending';
          coverage = { batchKey: key, paid, remaining, state, label: state === 'paid' ? 'Paid batch coverage' :
            state === 'partial' ? 'Partially paid batch' : row.status === 'no-payment' ? 'Pending batch (no saved payment)' : 'Pending batch' };
        }
      }
    }
    return [record.key, coverage];
  }));
}
export function parseFinancialNotes(notes: string): { batches: FinancialBatch[]; warning: string | null } {
  const separator = notes.indexOf('|');
  const body = separator >= 0 && !/\bPaid\s*:/i.test(notes.slice(0, separator)) ? notes.slice(separator + 1).trim() : notes.trim();
  if (!body) return { batches: [], warning: 'No task counts in notes.' };
  const count = (value: string) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error('Task count exceeds the supported range.');
    return result;
  };
  if (/correction|incorrect payment|\bPaid\s*:/i.test(body)) {
    const correction = /^Correction for incorrect payment in batch\s+(.+?)\s*\(Paid:\s*(\d+)\s*Att,\s*(\d+)\s*Rev\s*\|\s*Actual:\s*(\d+)\s*Att,\s*(\d+)\s*Rev\)\s*$/i.exec(body);
    if (!correction) return { batches: [], warning: 'Unrecognized correction: amount included, task counts excluded to avoid double-counting.' };
    return { batches: [{ name: correction[1]!.trim(), batchKey: batchName(correction[1]!), annotations: count(correction[4]!) - count(correction[2]!),
      reviews: count(correction[5]!) - count(correction[3]!), correction: true }], warning: null };
  }
  const batches: FinancialBatch[] = [];
  for (const part of body.split(';').map(value => value.trim()).filter(Boolean)) {
    const match = /^(?:UI Berry 3R:\s*)?(.+?)\s*-\s*Att:\s*(\d+),\s*Rev:\s*(\d+)\s*$/i.exec(part);
    if (!match) return { batches: [], warning: 'Notes contain an unsupported batch format: amount included, task counts unknown.' };
    batches.push({ name: match[1]!.trim(), batchKey: batchName(match[1]!), annotations: count(match[2]!), reviews: count(match[3]!), correction: false });
  }
  return { batches, warning: batches.length ? null : 'No task counts in notes.' };
}
export function financialEndpoint(url: string): { organizationId: string; start: string; end: string } | null {
  try {
    const value = new URL(url);
    const match = /^\/ui\/suppliers\/([^/]+)\/time$/.exec(value.pathname);
    if (value.origin !== GREENLIGHT_API || !match) return null;
    const parsed = z.object({ organizationId: id, start: date, end: date }).safeParse({
      organizationId: decodeURIComponent(match[1]!), start: value.searchParams.get('start'), end: value.searchParams.get('end'),
    });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export function normalizeFinancialTime(payload: unknown, url?: string): { payments: Payment[]; period: FinancialPeriod } {
  const parsed = financialTimeSchema.safeParse(payload);
  if (!parsed.success) throw new Error('Invalid Greenlight time JSON: identity, period, deliverable amount or status is unsupported.');
  const value = parsed.data;
  if (value.start > value.end) throw new Error('Financial date range is reversed.');
  if (url) {
    const endpoint = financialEndpoint(url);
    if (!endpoint || endpoint.organizationId !== value.organizationId || endpoint.start !== value.start || endpoint.end !== value.end) {
      throw new Error('Greenlight response does not match the captured supplier and requested period.');
    }
  }
  const capturedAt = new Date().toISOString();
  const seen = new Set<string>();
  const payments = value.deliverables.map(entry => {
    if (seen.has(entry.id)) throw new Error('Duplicate deliverable ID in the financial response.');
    seen.add(entry.id);
    if (entry.date < value.start || entry.date > value.end) throw new Error('Deliverable date is outside the reported period.');
    const notes = String(redact(entry.notes ?? ''));
    const parsedNotes = parseFinancialNotes(notes);
    return {
      key: JSON.stringify([value.organizationId, entry.id]), id: entry.id, organizationId: value.organizationId,
      engagementId: entry.engagementId, tag: String(redact(entry.engagementTag?.name ?? 'Untagged')),
      date: entry.date.slice(0, 10), amountCents: cents(entry.amount), status: entry.status,
      notes, batches: parsedNotes.batches, countWarning: parsedNotes.warning, updatedAt: entry.updatedAt ?? null, capturedAt,
    };
  });
  return { payments, period: { key: JSON.stringify([value.organizationId, value.start, value.end]), organizationId: value.organizationId,
    start: value.start, end: value.end, capturedAt, received: payments.length } };
}
export function exactSum(values: number[]): number {
  return values.reduce((sum, value) => {
    const result = sum + value;
    if (!Number.isSafeInteger(result)) throw new Error('Financial total exceeds the supported exact integer range.');
    return result;
  }, 0);
}
export function financialSummary(payments: Payment[]) {
  const paid = payments.filter(payment => payment.status === 4), pending = payments.filter(payment => payment.status !== 4);
  const counts = (rows: Payment[], dimension: 'annotations' | 'reviews') => exactSum(rows.flatMap(row => row.batches.map(batch => batch[dimension])));
  return {
    paidCents: exactSum(paid.map(row => row.amountCents)), pendingCents: exactSum(pending.map(row => row.amountCents)),
    paidEntries: paid.length, pendingEntries: pending.length,
    paidAnnotations: counts(paid, 'annotations'), pendingAnnotations: counts(pending, 'annotations'),
    paidReviews: counts(paid, 'reviews'), pendingReviews: counts(pending, 'reviews'),
    unknownCounts: payments.filter(payment => payment.countWarning).length,
  };
}
export function financialProjection(payments: Payment[], records: AnnotationRecord[], mappings: FinancialMapping[]) {
  if (new Set(mappings.map(mapping => mapping.dimension)).size > 1) throw new Error('Mixed project and iteration mappings can overlap. Use one mapping level.');
  const used = new Set<string>();
  return mappings.map(mapping => {
    const identity = JSON.stringify([mapping.dimension, mapping.annotationScope]);
    if (used.has(identity)) throw new Error('An annotation scope is mapped more than once. Remove overlapping financial mappings.');
    used.add(identity);
    const scoped = records.filter(record => record.source.url.startsWith('https://www.linkedin.com/') &&
      (mapping.dimension === 'iteration' ? record.iterationId : record.projectId) === mapping.annotationScope);
    const submitted = new Set(scoped.filter(record => record.state === 'SUBMITTED').map(record => record.id)).size;
    const matching = payments.filter(payment => payment.organizationId === mapping.organizationId && payment.engagementId === mapping.engagementId && payment.tag === mapping.tag);
    const counts = (paid: boolean) => exactSum(matching.filter(payment => (payment.status === 4) === paid).flatMap(payment =>
      payment.batches.filter(batch => batchName(batch.name) === batchName(mapping.batch)).map(batch => batch.annotations)));
    const paid = counts(true), pending = counts(false);
    const uncertain = matching.some(payment => payment.countWarning) || paid < 0 || pending < 0 || paid + pending > submitted;
    const remaining = uncertain ? null : submitted - paid - pending;
    const amount = remaining === null ? null : remaining * mapping.rateCents;
    if (amount !== null && !Number.isSafeInteger(amount)) throw new Error('Projected amount exceeds the supported range.');
    return { mapping, submitted, paid, pending, remaining, projectedCents: amount, uncertain };
  });
}
