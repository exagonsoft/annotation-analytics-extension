import type { AnnotationRecord } from './model';
import { csvCell } from './export';
import { redact } from './privacy';
import { groupName } from './analytics';

export interface ReviewFilters {
  search: string; from: string; to: string; dateBasis: 'created' | 'submitted';
  project: string; pipeline: string; iteration: string; state: string; reviewStatus: string;
  exact: string; min: string; max: string; hasReview: string; hasScore: string; hasFeedback: string; collected: string;
}
export const emptyReviewFilters: ReviewFilters = {
  search: '', from: '', to: '', dateBasis: 'created', project: '', pipeline: '', iteration: '', state: '', reviewStatus: '',
  exact: '', min: '', max: '', hasReview: '', hasScore: '', hasFeedback: '', collected: '',
};
export function reviewScore(record: AnnotationRecord): number | null {
  const score = record.detail?.data?.review.annotationScore;
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
}
export function reviewPipeline(record: AnnotationRecord): string {
  return record.detail?.data?.pipelineId !== null && record.detail?.data?.pipelineId !== undefined ? String(record.detail.data.pipelineId) : groupName(record.pipeline);
}
export function submittedDate(record: AnnotationRecord): string | null {
  return record.state === 'SUBMITTED' && record.detail?.data?.endedAt !== null && record.detail?.data?.endedAt !== undefined ? new Date(record.detail.data.endedAt).toISOString() : null;
}
export function reviewState(record: AnnotationRecord): string {
  if (record.detail?.status === 'failed') return record.detail.data ? 'Fetch failed (cached detail)' : 'Detail fetch failed';
  if (record.detail?.status === 'fetching') return 'Fetching detail';
  const review = record.detail?.data?.review;
  return !review ? 'Detail not fetched' : !review.reviewed ? 'Fetched, no review' : reviewScore(record) === null ? 'Reviewed, no numeric score' : 'Reviewed and scored';
}
export function filterReviews(records: AnnotationRecord[], filters: ReviewFilters): AnnotationRecord[] {
  const query = filters.search.trim().toLowerCase();
  return records.filter(record => {
    const data = record.detail?.data, review = data?.review, score = reviewScore(record);
    if (query && !`${record.id} ${record.taskId ?? ''} ${record.title ?? ''} ${review?.feedback ?? ''}`.toLowerCase().includes(query)) return false;
    const date = filters.dateBasis === 'submitted' ? submittedDate(record) : record.createdAt;
    if (filters.from && (!date || date < `${filters.from}T00:00:00.000Z`)) return false;
    if (filters.to && (!date || date > `${filters.to}T23:59:59.999Z`)) return false;
    if (filters.project && record.projectId !== filters.project || filters.pipeline && reviewPipeline(record) !== filters.pipeline ||
      filters.iteration && record.iterationId !== filters.iteration || filters.state && record.state !== filters.state ||
      filters.reviewStatus && review?.status !== filters.reviewStatus) return false;
    if (filters.exact !== '' && score !== Number(filters.exact) ||
      filters.min !== '' && (score === null || score < Number(filters.min)) ||
      filters.max !== '' && (score === null || score > Number(filters.max))) return false;
    if (filters.hasReview === 'yes' && !review?.reviewed || filters.hasReview === 'no' && (!data || review?.reviewed)) return false;
    if (filters.hasScore === 'yes' && score === null || filters.hasScore === 'no' && (!data || score !== null)) return false;
    if (filters.hasFeedback === 'yes' && !review?.feedback?.trim() || filters.hasFeedback === 'no' && (!data || !!review?.feedback?.trim())) return false;
    if (filters.collected === 'yes' && !data || filters.collected === 'no' && !!data || filters.collected === 'failed' && record.detail?.status !== 'failed') return false;
    return true;
  });
}
export function summarizeReviews(records: AnnotationRecord[]) {
  const scores = records.map(reviewScore).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const reviews = records.flatMap(record => record.detail?.data ? [record.detail.data.review] : []);
  const reviewed = reviews.filter(review => review.reviewed);
  const known = reviewed.filter(review => review.status !== null);
  const approved = known.filter(review => review.status === 'APPROVED').length;
  const statuses = new Map<string, number>(), distribution = new Map<number, number>();
  const patterns = new Map<string, { feedback: string; count: number }>();
  for (const review of reviewed) {
    const name = review.status ?? 'Unknown status';
    statuses.set(name, (statuses.get(name) ?? 0) + 1);
    if (review.feedback?.trim()) {
      const key = review.feedback.toLowerCase().replace(/\s+/g, ' ').trim();
      const pattern = patterns.get(key);
      if (pattern) pattern.count++; else patterns.set(key, { feedback: review.feedback, count: 1 });
    }
  }
  for (const score of scores) distribution.set(score, (distribution.get(score) ?? 0) + 1);
  const middle = Math.floor(scores.length / 2);
  return {
    total: records.length, submitted: records.filter(r => r.state === 'SUBMITTED').length,
    collected: reviews.length, pending: records.filter(r => !r.detail?.data && r.detail?.status !== 'failed').length,
    failed: records.filter(r => r.detail?.status === 'failed').length,
    reviewed: reviewed.length, approved, otherStatuses: known.length - approved, unknownStatuses: reviewed.length - known.length,
    missingReviews: reviews.filter(review => !review.reviewed).length, scored: scores.length,
    average: scores.length ? scores.reduce((sum, score) => sum + score / scores.length, 0) : null,
    min: scores[0] ?? null, max: scores.at(-1) ?? null,
    median: scores.length ? scores.length % 2 ? scores[middle]! : scores[middle - 1]! / 2 + scores[middle]! / 2 : null,
    approvalDenominator: known.length, approvalRate: known.length ? approved / known.length * 100 : null,
    distribution: [...distribution].map(([value, count]) => ({ name: String(value), count })),
    statuses: [...statuses].map(([name, count]) => ({ name, count })),
    feedbackPatterns: [...patterns.values()].filter(p => p.count > 1).sort((a, b) => b.count - a.count),
  };
}
export function reviewGroups(records: AnnotationRecord[], key: (record: AnnotationRecord) => string) {
  const groups = new Map<string, AnnotationRecord[]>();
  for (const record of records) {
    const name = key(record), group = groups.get(name);
    if (group) group.push(record); else groups.set(name, [record]);
  }
  return [...groups].map(([name, items]) => ({ name, ...summarizeReviews(items) })).sort((a, b) => a.name.localeCompare(b.name));
}
export function reviewCsv(records: AnnotationRecord[]): string {
  const header = ['annotation_id', 'task_id', 'task_title', 'project_id', 'pipeline_id', 'iteration_id', 'submitted_at', 'annotation_state', 'review_status', 'annotation_score', 'reviewed', 'review_feedback', 'collection_status', 'detail_fetched_at', 'duration_seconds', 'idle_duration_seconds'];
  return '\uFEFF' + [header.join(','), ...records.map(record => {
    const data = record.detail?.data;
    return [record.id, record.taskId, record.title, record.projectId, reviewPipeline(record), record.iterationId, submittedDate(record), record.state,
      data?.review.status, reviewScore(record), data?.review.reviewed ?? null, data?.review.feedback, reviewState(record), record.detail?.fetchedAt, data?.durationInSeconds, data?.idleDurationInSeconds]
      .map(value => csvCell(redact(value))).join(',');
  })].join('\r\n');
}
