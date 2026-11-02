import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FilterBar, Modal } from '../src/ui/components';
import { useApp } from '../src/ui/store';
import { emptyFilters } from '../src/core/model';
import { normalize } from '../src/core/parsing';
import { newSource } from '../src/core/storage';
import { fixture, mappings } from './fixtures';
import { Analytics, ScoreMetrics } from '../src/ui/Analytics';
import { reviewFixture } from './review-fixtures';
import { LINKEDIN_ORIGIN } from '../src/core/review';
import { ReviewCacheSummary } from '../src/ui/ReviewCacheSummary';
import { ReviewAnalytics } from '../src/ui/ReviewAnalytics';
import { emptyReviewFilters } from '../src/core/review-analytics';

describe('dashboard controls', () => {
  it('uses the entire local data source as the primary read-only review dashboard and shares its filters', () => {
    const records = [
      normalize(fixture('unknown-origin-import'), newSource('import'))!,
      normalize(reviewFixture(), newSource('import', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901345`))!,
    ];
    useApp.setState({ records, sources: [], reviewFilters: emptyReviewFilters });
    render(<ReviewAnalytics />);
    expect(screen.getByText('Total Annotations').closest('article')).toHaveTextContent('2');
    expect(screen.getByText('Average Annotation Score').closest('article')).toHaveTextContent('4.00');
    expect(screen.queryByRole('button', { name: 'Fetch Review Scores' })).not.toBeInTheDocument();
    expect(screen.queryByText('Average Overall', { exact: true })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search reviews'), { target: { value: 'unknown-origin-import' } });
    expect(useApp.getState().reviewFilters.search).toBe('unknown-origin-import');
    expect(screen.getByText('Total Annotations').closest('article')).toHaveTextContent('1');
    expect(screen.getByText('Average Annotation Score').closest('article')).toHaveTextContent('Unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Clear review filters' }));
  });
  it('updates and resets combined global filters', () => {
    useApp.setState({ records: [normalize(fixture(), newSource('import'), mappings)!], filters: emptyFilters });
    render(<FilterBar />);
    fireEvent.change(screen.getByLabelText('Search annotations'), { target: { value: '291' } });
    expect(useApp.getState().filters.search).toBe('291');
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-1' } });
    expect(useApp.getState().filters.project).toBe('project-1');
    fireEvent.click(screen.getByText('Clear all'));
    expect(useApp.getState().filters).toEqual(emptyFilters);
  });
  it('renders an accessible, escaped read-only inspection dialog', () => {
    render(<Modal title="Inspect annotation" onClose={() => {}}><pre>{'<script>alert("x")</script>'}</pre></Modal>);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Inspect annotation');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByLabelText('Close dialog')).toBeInTheDocument();
  });
  it('displays categorical Overall results without inventing a numeric average', () => {
    const record = normalize(fixture('categorical', { annotationData: '{"overall":"Website A better"}' }), newSource('import'), {
      overall: { path: 'annotationData.overall', kind: 'categorical', level: 'annotation' },
    })!;
    render(<ScoreMetrics records={[record]} />);
    expect(screen.getByText('Categorical')).toBeInTheDocument();
    expect(screen.getByText('No categorical-to-numeric conversion')).toBeInTheDocument();
  });
  it('distinguishes overlapping scoped server totals rather than adding them', () => {
    useApp.setState({ records: [], sources: [{ ...newSource('api'), reportedTotal: 100 }, { ...newSource('devtools'), reportedTotal: 100 }] });
    render(<Analytics records={[]} />);
    expect(screen.getByText('Server total: multiple scoped totals — see Sources')).toBeInTheDocument();
    expect(screen.queryByText('200 reported by server (source scope)')).not.toBeInTheDocument();
  });
  it('explains unavailable task answers instead of showing Unknown metrics and empty charts over saved reviewer scores', () => {
    const record = normalize(reviewFixture(), newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901345`))!;
    useApp.setState({ records: [record], sources: [], filters: emptyFilters });
    const open = vi.fn();
    render(<Analytics records={[record]} results onOpenReviews={open} />);
    expect(screen.getByText('Total annotations').closest('article')).toHaveTextContent('1');
    expect(screen.getByText('No mapped task-answer scores')).toBeInTheDocument();
    expect(screen.queryByText('Average Overall', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Overall distribution', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show cached reviewer scores' }));
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('keeps cached reviewer quality separate from unmapped task answers', () => {
    const record = normalize(reviewFixture(), newSource('devtools', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/7901345`))!;
    useApp.setState({ records: [record], sources: [], filters: emptyFilters });
    render(<Analytics records={[record]} />);
    const cached = within(screen.getByRole('region', { name: 'Cached review analytics' }));
    expect(cached.getByText('4.00')).toBeInTheDocument();
    expect(cached.getByText('Cached review details')).toBeInTheDocument();
    expect(screen.queryByText('Average Overall', { exact: true })).not.toBeInTheDocument();
  });
  it('uses verified cached details in the compact summary, preserving zero and excluding missing or unverified scores', () => {
    const records = [
      normalize(reviewFixture(1, { currentVersionReview: { annotationScore: 0, status: 'APPROVED' } }), newSource('import', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/1`))!,
      normalize(reviewFixture(2, { currentVersionReview: null }), newSource('import', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/2`))!,
      normalize(reviewFixture(3), newSource('import', `${LINKEDIN_ORIGIN}/ai-trainer/api/frontendAnnotationTaskResults/3`))!,
    ];
    records[2]!.detail!.verified = false;
    const open = vi.fn();
    render(<ReviewCacheSummary records={records} compact onOpenReviews={open} />);
    expect(screen.getByText('Cached review details').closest('article')).toHaveTextContent('2');
    expect(screen.getByText('Average Annotation Score').closest('article')).toHaveTextContent('0.00');
    expect(screen.getByText(/1 awaiting enrichment/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Review Analytics' }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
