import type { AnnotationRecord } from '../core/model';
import { hasCachedDetail } from '../core/review';
import { summarizeReviews } from '../core/review-analytics';
import { Badge, Metric } from './components';

export function ReviewCacheSummary({ records, compact = false, onOpenReviews }: {
  records: AnnotationRecord[];
  compact?: boolean;
  onOpenReviews?: () => void;
}) {
  const cached = records.filter(hasCachedDetail);
  const stats = summarizeReviews(cached);
  return <section className={`card review-cache ${compact ? 'compact-cache' : ''}`} aria-label="Cached review analytics">
    <div className="section-heading"><h3>Cached reviewer quality</h3><Badge good={cached.length > 0}>IndexedDB · local</Badge></div>
    <p className="muted">{compact ? 'All locally saved annotations.' : 'Matching current dashboard filters.'} Reviewer quality is separate from task-answer Overall preferences.</p>
    <div className="metrics">
      <Metric label="Cached review details" value={cached.length.toLocaleString()} note={`${records.length.toLocaleString()} annotations in scope`} />
      <Metric label="Average Annotation Score" value={stats.average === null ? 'Unknown' : stats.average.toFixed(2)} note={`${stats.scored.toLocaleString()} numeric reviewer scores · range unverified`} accent />
      <Metric label="Reviewed" value={stats.reviewed.toLocaleString()} note={`${stats.missingReviews.toLocaleString()} cached details without a review`} />
      <Metric label="Approved" value={stats.approved.toLocaleString()} note={stats.approvalRate === null ? 'Approval rate unknown · no known statuses' :
        `${stats.approvalRate.toFixed(1)}% of ${stats.approvalDenominator.toLocaleString()} reviewed with known status`} />
    </div>
    <p className="muted">{(records.length - cached.length).toLocaleString()} awaiting enrichment. Reads saved data only; opening this view does not fetch or navigate tasks. Cached details have no automatic expiry.</p>
    {onOpenReviews && <button onClick={onOpenReviews}>Open Review Analytics</button>}
  </section>;
}
