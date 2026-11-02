import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnnotationRecord } from '../core/model';
import { distribution, groupName, hasScore, scoreSummary, summarize, timeline } from '../core/analytics';
import { Badge, Empty, Metric } from './components';
import { useApp } from './store';
import { ReviewCacheSummary } from './ReviewCacheSummary';

const colors = ['#a78bfa', '#22d3ee', '#60a5fa', '#fbbf24', '#f472b6', '#34d399'];
const tooltipStyle = { background: '#171d2d', border: '1px solid #36405a', borderRadius: 10, color: '#f1f5f9' };
export function Distribution({ title, data }: { title: string; data: { name: string; count: number; percentage?: number }[] }) {
  return <section className="card chart-card"><h3>{title}</h3>{data.length ? <>
    <div className="chart" role="img" aria-label={data.map(v => `${v.name}: ${v.count}`).join(', ')}><ResponsiveContainer width="100%" height="100%"><BarChart data={data.slice(0, 20)} margin={{ bottom: 20 }}>
      <CartesianGrid stroke="#263045" vertical={false} /><XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} interval={0} angle={-15} /><YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
      <Tooltip contentStyle={tooltipStyle} /><Bar isAnimationActive={false} dataKey="count" radius={[4, 4, 0, 0]}>{data.slice(0, 20).map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}</Bar>
    </BarChart></ResponsiveContainer></div>
    <details><summary>View all values ({data.length})</summary><div className="distribution-list">{data.map(v => <div key={v.name}><span>{v.name}</span><b>{v.count}{v.percentage !== undefined && ` · ${v.percentage.toFixed(1)}%`}</b></div>)}</div></details>
  </> : <p className="muted chart-empty">No verified results available.</p>}</section>;
}
export function ScoreMetrics({ records, answers = true }: { records: AnnotationRecord[]; answers?: boolean }) {
  const stats = summarize(records);
  const overall = stats.overall;
  const summary = overall.numeric.length === 1 ? overall.numeric[0]!.mean.toFixed(2) : overall.numeric.length > 1 ? 'Multiple scales' : overall.categories.length ? 'Categorical' : 'Unknown';
  return <div className="metrics">
    <Metric label="Total annotations" value={stats.total.toLocaleString()} note="Matching current filters" accent />
    <Metric label="Submitted" value={stats.submitted.toLocaleString()} note="Annotation state only" />
    <Metric label="Pending" value={stats.pending.toLocaleString()} note="Known pending states only" />
    {answers && <Metric label="Scored annotations" value={stats.scored.toLocaleString()} note="At least one verified result" />}
    {answers && <Metric label="Average Overall" value={summary} note={overall.numeric.length === 1 ? `${overall.numeric[0]!.count} scored · ${overall.numeric[0]!.scale}` : 'No categorical-to-numeric conversion'} accent />}
    <Metric label="Completion rate" value={stats.completionRate === null ? '—' : `${stats.completionRate.toFixed(1)}%`} note="Submitted / matching loaded records" />
    {answers && <Metric label="Aesthetics results" value={stats.aesthetics.scored.toLocaleString()} note="Verified numeric or categorical" />}
    {answers && <Metric label="Functionality results" value={stats.functionality.scored.toLocaleString()} note="Verified numeric or categorical" />}
  </div>;
}
export function Analytics({ records, results = false, onOpenReviews }: { records: AnnotationRecord[]; results?: boolean; onOpenReviews?: () => void }) {
  const allRecords = useApp(s => s.records);
  const sources = useApp(s => s.sources);
  const reportedSources = sources.filter(source => source.reportedTotal !== null);
  const trend = useMemo(() => timeline(records), [records]);
  const numeric = scoreSummary(records, 'overall').numeric;
  const hasTaskAnswers = records.some(hasScore);
  const [chosenScale, setScale] = useState('');
  const activeScale = numeric.some(s => s.scale === chosenScale) ? chosenScale : numeric[0]?.scale ?? '';
  const groups = [
    ['Project', (r: AnnotationRecord) => r.projectId ?? 'Unknown'],
    ['Iteration', (r: AnnotationRecord) => r.iterationId ?? 'Unknown'],
    ['Pipeline', (r: AnnotationRecord) => groupName(r.pipeline)],
    ['Template', (r: AnnotationRecord) => r.templateId ?? 'Unknown'],
  ] as const;
  return <>
    <div className="collection-strip"><span><span className="dot" />{allRecords.length.toLocaleString()} loaded</span><span>{records.length.toLocaleString()} matching filters</span>
      <span>{reportedSources.length === 1 ? `${reportedSources[0]!.reportedTotal!.toLocaleString()} reported by server (source scope)` : reportedSources.length ? 'Server total: multiple scoped totals — see Sources' : 'Server total: unknown'}</span>
      <Badge good={sources.length > 0 && sources.every(s => s.completeness === 'complete')}>{sources.length && sources.every(s => s.completeness === 'complete') ? 'Sources marked complete' : 'Partial / unverified collection'}</Badge>
      <span>{sources.reduce((n, s) => n + s.errors, 0)} collection errors</span>
    </div>
    {(['overall', 'aesthetics', 'functionality'] as const).some(d => scoreSummary(records, d).conflictingTasks > 0) && <p className="warning">Conflicting results were found for a shared task identity. Those task groups are excluded from score aggregates. Inspect task-level mappings and source records.</p>}
    {!results && <ReviewCacheSummary records={records} onOpenReviews={onOpenReviews} />}
    <h3>Task-answer analytics</h3>
    <p className="muted">These metrics use mapped Aesthetics, Functionality and Overall answers, not reviewer quality scores. Use Review Analytics for review-specific filters and feedback.</p>
    <ScoreMetrics records={records} answers={hasTaskAnswers} />
    {!records.length ? <Empty title={allRecords.length ? 'No matching annotations' : undefined}>{allRecords.length ? 'Clear or adjust your filters to see loaded results.' : undefined}</Empty> : !hasTaskAnswers ? <Empty title="No mapped task-answer scores">
      The matching saved annotations contain no verified Overall, Aesthetics or Functionality answers. This does not mean their cached reviewer scores are missing.<br /><br />
      Reviewer scores use currentVersionReview.annotationScore. Task answers require their own real fields and verified mappings in Settings; an attempt URL or task title is not a score.<br /><br />
      {onOpenReviews && <button onClick={onOpenReviews}>Show cached reviewer scores</button>}
    </Empty> : <div className="chart-grid">
      {!results && <>
        <section className="card chart-card wide"><div className="section-heading"><h3>Annotation volume & submission trends</h3><Badge>By creation date · UTC</Badge></div>
          <div className="chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={trend}>
            <CartesianGrid stroke="#263045" vertical={false} /><XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fill: '#94a3b8' }} /><Tooltip contentStyle={tooltipStyle} />
            <Line isAnimationActive={false} type="monotone" dataKey="volume" stroke="#a78bfa" strokeWidth={2} dot={false} /><Line isAnimationActive={false} type="monotone" dataKey="submitted" stroke="#22d3ee" strokeWidth={2} dot={false} />
          </LineChart></ResponsiveContainer></div><p className="muted">Volume and submitted-state counts grouped by creation date; these are not historical state transitions.</p>
        </section>
        <section className="card chart-card"><h3>Status distribution</h3><div className="chart"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie isAnimationActive={false} data={distribution(records, r => r.state ?? 'Unknown')} dataKey="count" nameKey="name" innerRadius={55} outerRadius={85}>{distribution(records, r => r.state ?? 'Unknown').map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}</Pie><Tooltip contentStyle={tooltipStyle} /></PieChart></ResponsiveContainer></div><div className="legend">{distribution(records, r => r.state ?? 'Unknown').map((s, i) => <span key={s.name}><i style={{ background: colors[i % colors.length] }} />{s.name} {s.count}</span>)}</div></section>
      </>}
      {(['overall', 'aesthetics', 'functionality'] as const).map(dimension => <Distribution key={dimension} title={`${dimension[0]!.toUpperCase()}${dimension.slice(1)} distribution`} data={scoreSummary(records, dimension).values} />)}
      <section className="card chart-card wide"><div className="section-heading"><h3>Overall numeric score trend</h3><select aria-label="Trend numeric scale" value={activeScale} onChange={e => setScale(e.target.value)}>{numeric.map(s => <option key={s.scale}>{s.scale}</option>)}</select></div>
        {numeric.length ? <><div className="chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={trend.map(day => ({ date: day.date, mean: day.averages.find(s => s.scale === activeScale)?.mean ?? null }))}><CartesianGrid stroke="#263045" vertical={false} /><XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} /><YAxis tick={{ fill: '#94a3b8' }} /><Tooltip contentStyle={tooltipStyle} /><Line isAnimationActive={false} dataKey="mean" stroke="#22d3ee" strokeWidth={2} connectNulls={false} /></LineChart></ResponsiveContainer></div><div className="distribution-list">{numeric.map(s => <div key={s.scale}><span>{s.scale}</span><b>Mean {s.mean.toFixed(3)} · n={s.count}</b></div>)}</div></> : <p className="muted chart-empty">Map a verified numeric field in Settings to enable this chart. Missing scores never count as zero.</p>}
      </section>
      <Distribution title="Overall categorical preferences" data={scoreSummary(records, 'overall').categories} />
      {groups.map(([name, key]) => <Distribution key={name} title={`Results by ${name.toLowerCase()}`} data={distribution(records, key)} />)}
      <Distribution title="Scored versus unscored" data={distribution(records, r => Object.values(r.scores).some(s => s.scoringStatus === 'verified') ? 'Scored' : 'Unscored')} />
    </div>}
  </>;
}
