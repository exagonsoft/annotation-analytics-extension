import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Pause, Play, RefreshCw, Square } from 'lucide-react';
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnnotationRecord } from '../core/model';
import { emptyReviewFilters, filterReviews, reviewCsv, reviewGroups, reviewPipeline, reviewScore, reviewState, submittedDate, summarizeReviews, type ReviewFilters } from '../core/review-analytics';
import { annotationId, defaultReviewConfig, hasCachedDetail, LINKEDIN_ORIGIN, reviewDiagnosticsReport, type ReviewCollectionMethod, type ReviewRun } from '../core/review';
import { reviewEligible } from '../collectors/AnnotationDetailCollector';
import { controlReviewJob, launchReviewJob, waitForReviewRun } from '../collectors/review-jobs';
import { download } from '../core/export';
import { db, saveReviewConfig } from '../core/storage';
import { Distribution } from './Analytics';
import { Badge, Empty, Metric, Modal, Select } from './components';
import { action, useApp } from './store';

function Feedback({ record, onClose }: { record: AnnotationRecord; onClose: () => void }) {
  const entry = record.detail, data = entry?.data;
  return <Modal title={`Review for annotation ${record.id}`} onClose={onClose} description="Reviewer quality is separate from task preference answers. Only selected, redacted detail fields are retained.">
    <div className="detail-meta"><h3>{record.title ?? `Task ${record.taskId ?? 'unknown'}`}</h3><Badge>{reviewState(record)}</Badge></div>
    <div className="progress-stats"><div><small>Quality score · range unverified</small><b>{reviewScore(record) ?? 'Unknown'}</b></div><div><small>Review status</small><b>{data?.review.status ?? 'Unknown'}</b></div><div><small>Related task ID (not annotation ID)</small><b>{record.taskId ?? 'Unknown'}</b></div></div>
    <h3>Complete reviewer feedback</h3><pre className="json-view feedback-text">{data?.review.feedback ?? 'No feedback available. Unfetched details are unknown, not unreviewed.'}</pre>
    <button disabled={!data?.review.feedback} onClick={() => void action(() => navigator.clipboard.writeText(data?.review.feedback ?? ''))}><Copy size={14} />Copy redacted feedback</button>
    <p className="muted">Last observed: {entry?.fetchedAt ?? 'Never'}. A review timestamp is not provided by the confirmed contract.</p>
    {data?.warnings.map(warning => <p className="warning" key={warning}>{warning}</p>)}
    <details><summary>Normalized detail, timing & request diagnostics</summary><pre className="json-view">{JSON.stringify(entry, null, 2)}</pre></details>
  </Modal>;
}
function CollectionDiagnostics({ run, records, running, error }: { run?: ReviewRun | null; records: AnnotationRecord[]; running: boolean; error: string }) {
  const diagnostics = run?.diagnostics;
  const eligible = records.filter(record => reviewEligible(record.source.url, String(record.id)));
  const unknown = 'Not initialized';
  return <section aria-label="Detail collection diagnostics">
    <div className="section-heading"><h3>Detail collection diagnostics</h3><button disabled={!diagnostics} onClick={() => {
      if (run) download(reviewDiagnosticsReport(run, error), 'annotation-detail-diagnostics.json', 'application/json');
    }}><Download size={14} />Export sanitized diagnostics</button></div>
    <dl className="progress-stats">{[
      ['Annotation IDs discovered', diagnostics?.discovered ?? new Set(records.map(record => String(record.id))).size],
      ['Annotation IDs eligible for enrichment', diagnostics?.eligible ?? new Set(eligible.map(record => String(record.id))).size],
      ['Annotation IDs skipped due to cache', diagnostics?.skippedCache ?? eligible.filter(hasCachedDetail).length],
      ['Requests queued', diagnostics?.queued ?? unknown], ['Dispatch attempts', diagnostics?.dispatched ?? unknown],
      ['Requests started', diagnostics?.started ?? unknown], ['Requests completed', diagnostics?.completed ?? unknown],
      ['Requests failed', diagnostics?.failed ?? unknown],
      ['HTTP response codes', diagnostics ? Object.entries(diagnostics.httpCodes).map(([code, count]) => `${code}: ${count}`).join(', ') || 'None received' : unknown],
      ['Latest attempted endpoint path', diagnostics?.latestEndpoint ?? 'None'],
      ['Latest request error', error || diagnostics?.latestError || 'None'],
      ['Active collection state', error ? 'Blocked before execution' : running ? 'Running' : run?.status === 'running' ? 'Saved running state (another page or interrupted)' : run?.status ?? 'Ready'],
      ['Execution context', diagnostics?.executionContext ?? 'Chrome scripting ISOLATED world in selected LinkedIn tab; same-origin session GET'],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="muted">Dispatch is not proof of a GET. Direct GET starts are confirmed by the injected fetch context; website-driven GETs are confirmed when DevTools observes the completed native request, not when a task is clicked. Completed includes settled browser requests; failed includes pre-request execution errors and retries. HTTP codes are recorded separately. Counters accumulate across resume; events retain the latest 200 attempts. The queue is independent of analytics filters.</p>
    {diagnostics?.events.length ? <details><summary>Safe request events</summary><pre className="json-view">{diagnostics.events.map(event => `${event.at} ${event.type} annotationId=${event.annotationId}${event.status === null ? '' : ` status=${event.status}`}${event.error ? ` ${event.error}` : ''}`).join('\n')}</pre></details> : <p>No request events recorded for this run.</p>}
  </section>;
}
export function ReviewCollectionControls({ records, selected }: { records: AnnotationRecord[]; selected: string[] }) {
  const { settings, reviewRuns } = useApp();
  const [config, setConfig] = useState(settings.reviewCollector ?? defaultReviewConfig);
  const [preparing, setPreparing] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [preparationError, setPreparationError] = useState('');
  const [accessNotice, setAccessNotice] = useState('');
  const [testId, setTestId] = useState('');
  const [testResult, setTestResult] = useState('');
  const [method, setMethod] = useState<ReviewCollectionMethod>('website');
  const starting = useRef(false);
  const mounted = useRef(true);
  const run = reviewRuns.find(saved => saved.status === 'running' && saved.jobId) ?? reviewRuns[0];
  const running = preparing || run?.status === 'running' && !!run.jobId;
  const eligible = records.filter(record => reviewEligible(record.source.url, record.id));
  const summary = summarizeReviews(eligible);
  const pending = eligible.filter(record => !hasCachedDetail(record)).length;
  useEffect(() => { setConfig(settings.reviewCollector ?? defaultReviewConfig); }, [settings.reviewCollector]);
  useEffect(() => { if (run?.method) setMethod(run.method); }, [run?.id, run?.method]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  async function start(refresh: boolean, resume?: ReviewRun, ids?: string[], diagnostic = false, methodOverride?: ReviewCollectionMethod) {
    if (starting.current) return;
    starting.current = true; setPreparing(true); setPreparationError('');
    try {
      const selectedMethod = diagnostic ? 'session' : resume ? resume.method ?? 'session' : methodOverride ?? method;
      setMethod(selectedMethod);
      if (diagnostic) { ids = [String(annotationId(testId.trim()))]; setTestResult('Starting one production request with no retries...'); }
      if (!diagnostic) await saveReviewConfig(config);
      const job = await launchReviewJob({
        method: selectedMethod, config: diagnostic ? { ...config, concurrency: 1, maxRetries: 0 } : config,
        refresh, resumeId: resume?.id, annotationIds: ids,
      });
      if (diagnostic) {
        const result = await waitForReviewRun(job.runId);
        const record = await db.records.where('id').equals(ids![0]!).filter(record => reviewEligible(record.source.url, record.id)).first();
        const review = result.completed > 0 ? record?.detail?.data?.review : null;
        if (mounted.current) setTestResult(review ? `Saved annotation ${ids![0]} · HTTP ${Object.keys(result.diagnostics?.httpCodes ?? {}).join(', ')} · score ${review.annotationScore ?? 'unknown'} · review status ${review.status ?? 'unknown'} · feedback ${review.feedback ? 'available' : 'absent'}` :
          `No detail saved: ${result.diagnostics?.latestError ?? result.message}`);
      }
    } catch (error) {
      if (mounted.current) { setPreparationError(error instanceof Error ? error.message : 'Collection initialization failed.'); if (diagnostic) setTestResult('No diagnostic detail saved. See the collection error.'); }
      throw error;
    } finally { starting.current = false; if (mounted.current) setPreparing(false); }
  }
  return <section className="card">
    <div className="section-heading"><h3>Stage B · Collect reviewer quality scores</h3><Badge good={!summary.failed && summary.collected === eligible.length && eligible.length > 0}>{running ? 'Collecting' : run?.status === 'running' ? 'Saved running state' : run?.status ?? 'Ready'}</Badge></div>
    <p>Stage A is your existing paginated list collection in Sources. This user-started ingestion job uses only discovered annotation <b>IDs</b>. It runs in a non-active collection tab and writes the local data source. You can navigate the dashboard or close the popup without stopping it. Keep the collection tab and authorized website open.</p>
    <p className="muted">{eligible.length.toLocaleString()} discovered · {(eligible.length - pending).toLocaleString()} cached · {pending.toLocaleString()} uncached requests pending.</p>
    <p className="muted"><b>Persistent cache enabled.</b> Successfully loaded details, including no-review results, are saved in IndexedDB with no automatic expiry. Normal collection and restart/resume skip them in both methods. Only explicit Refresh actions re-fetch cached reviews; failed refreshes retain the last good data. Clearing current results deletes this cache; save a snapshot first.</p>
    <p><b>Website collection:</b> open DevTools on the selected LinkedIn tab, then choose <b>Collect through website</b>. This arms capture, clicks existing task links or opens their normal task pages, and saves the website's own detail responses. It navigates that tab without reading cookies or tokens. Keep DevTools open; Pause stops further navigation.</p>
    <div className="filter-grid">
      <label className="field">Collection method<select disabled={running} value={method} onChange={event => setMethod(event.target.value === 'website' ? 'website' : 'session')}><option value="session">Direct session API</option><option value="website">Website clicks + DevTools capture</option></select></label>
      <label className="field">Concurrency (1–3)<input type="number" min={1} max={3} disabled={running} value={config.concurrency} onChange={e => setConfig({ ...config, concurrency: Number(e.target.value) })} /></label>
      <label className="field">Pacing between request starts (ms)<input type="number" min={500} max={30000} disabled={running} value={config.delayMs} onChange={e => setConfig({ ...config, delayMs: Number(e.target.value) })} /></label>
      <label className="field">Transient retries (0–3)<input type="number" min={0} max={3} disabled={running} value={config.maxRetries} onChange={e => setConfig({ ...config, maxRetries: Number(e.target.value) })} /></label>
    </div>
    <div className="toolbar">
      <button className="primary" disabled={running} onClick={() => void action(() => start(false))}><Play size={15} />Fetch Review Scores</button>
      <button disabled={running} onClick={() => void action(() => start(false, undefined, undefined, false, 'website'))}>Collect through website</button>
      <button disabled={running || !run || run.status === 'complete'} onClick={() => void action(() => start(false, run))}>Resume saved queue</button>
      <button disabled={!running || !run?.jobId} onClick={() => { if (run) void action(() => controlReviewJob(run, 'pause')); }}><Pause size={14} />Pause</button>
      <button disabled={!running || !run?.jobId} onClick={() => { if (run) void action(() => controlReviewJob(run, 'cancel')); }}><Square size={14} />Cancel</button>
      <button disabled={running || !eligible.length} onClick={() => { if (window.confirm('Recheck all discovered annotations, including previously cached reviews? This makes new session requests.')) void action(() => start(true)); }}><RefreshCw size={14} />Refresh Existing Reviews</button>
      <button disabled={running || !selected.length} onClick={() => { if (window.confirm(`Force refresh ${selected.length} selected annotation reviews?`)) void action(() => start(true, undefined, selected)); }}>Force Refresh Selected Reviews</button>
      <button disabled={running} onClick={() => void action(async () => {
        const granted = await chrome.permissions.request({ origins: [`${LINKEDIN_ORIGIN}/*`] });
        if (!granted) throw new Error('LinkedIn collection access was denied. Use the popup activeTab grant or DevTools/import.');
        setAccessNotice('LinkedIn host access granted. Select the authorized AI Trainer tab with the popup, then start collection.');
      })}>Grant LinkedIn collection access</button>
    </div>
    {method === 'website' && <p className="muted">Website mode always uses one task at a time, at least 1,500 ms between starts, no automatic retries, and a 60-second response timeout. Resume preserves this method. Capture remains armed until you stop it in Sources. A click alone is never reported as a successful detail request.</p>}
    {accessNotice && <p role="status">{accessNotice}</p>}
    {import.meta.env.MODE === 'development' && <fieldset><legend>Development-only live diagnostic</legend>
      <label className="field">Discovered annotation ID<input inputMode="numeric" value={testId} onChange={event => setTestId(event.target.value)} /></label>
      <button disabled={running} onClick={() => void action(() => start(true, undefined, undefined, true))}>Test Annotation Detail Request</button>
      <p className="muted">Uses the production collector and actual authorized tab, bypasses cache for this discovered ID, and makes at most one attempt. No fixtures or credentials are supplied.</p>
      {testResult && <p role="status">{testResult}</p>}
    </fieldset>}
    <div className="progress-stats">{[
      ['Total discovered', summary.total], ['Completed / cached', summary.collected], ['Remaining uncached', pending], ['Failed records', summary.failed],
      ['Reviewed', summary.reviewed], ['Scored', summary.scored], ['Current GET starts / min (rolling 60s)', run?.diagnostics?.events.filter(event => event.type === 'DETAIL_REQUEST_STARTED' && Date.parse(event.at) >= clock - 60_000).length ?? 0],
    ].map(([label, count]) => <div key={label}><small>{label}</small><b>{count}</b></div>)}</div>
    {run?.message && <p role="status" className={run.status === 'paused' ? 'warning' : 'muted'}>{run.message}{run.notBefore ? ` Earliest resume: ${new Date(run.notBefore).toLocaleString()}.` : ''}</p>}
    <CollectionDiagnostics run={run} records={records} running={running} error={preparationError} />
    <p className="muted">401, 403 and 429 pause the queue; there is no credential workaround or automatic polling. Leaving this screen does not stop ingestion. Closing the collection tab or restarting Chrome interrupts it; Resume uses saved results. Every interface reads the local data source, not a live API.</p>
  </section>;
}
const tableColumns = ['Annotation ID', 'Task title', 'Project', 'Pipeline', 'Submitted date', 'Annotation state', 'Review status', 'Annotation score', 'Reviewer feedback', 'Collection status'];
function tableValue(record: AnnotationRecord, column: number): string | number {
  return [record.id, record.title ?? '—', record.projectId ?? '—', reviewPipeline(record), submittedDate(record) ?? '—', record.state ?? '—',
    record.detail?.data?.review.status ?? '—', reviewScore(record) ?? '—', record.detail?.data?.review.feedback ?? '—', reviewState(record)][column] ?? '—';
}
function ReviewTable({ records, inspect, selected, select }: { records: AnnotationRecord[]; inspect: (record: AnnotationRecord) => void; selected: string[]; select: (ids: string[]) => void }) {
  const [sort, setSort] = useState({ column: 0, asc: true });
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => [...records].sort((a, b) => {
    const left = tableValue(a, sort.column), right = tableValue(b, sort.column);
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
    return sort.asc ? order : -order;
  }), [records, sort]);
  const last = Math.max(0, Math.ceil(sorted.length / 50) - 1), current = Math.min(page, last);
  return <section className="card"><div className="section-heading"><h3>Review feedback table · {records.length.toLocaleString()} annotations</h3><button onClick={() => download(reviewCsv(records), 'annotation-reviews.csv', 'text/csv')}><Download size={14} />Export review CSV</button></div>
    <div className="review-table-scroll"><table className="review-table"><thead><tr><th><input type="checkbox" aria-label="Select all matching reviews" checked={!!records.length && records.every(record => selected.includes(record.id))} onChange={event => select(event.target.checked ? [...new Set([...selected, ...records.map(record => record.id)])] : selected.filter(id => !records.some(record => record.id === id)))} /></th>{tableColumns.map((name, column) => <th key={name} aria-sort={sort.column === column ? sort.asc ? 'ascending' : 'descending' : 'none'}><button onClick={() => setSort(prev => ({ column, asc: prev.column === column ? !prev.asc : true }))}>{name}</button></th>)}</tr></thead>
      <tbody>{sorted.slice(current * 50, current * 50 + 50).map(record => <tr key={record.key}><td><input type="checkbox" aria-label={`Select review ${record.id}`} checked={selected.includes(record.id)} onChange={event => select(event.target.checked ? [...selected, record.id] : selected.filter(id => id !== record.id))} /></td>{tableColumns.map((name, column) => <td key={name}><button title={String(tableValue(record, column))} onClick={() => inspect(record)}>{String(tableValue(record, column))}</button></td>)}</tr>)}</tbody></table>
    </div>
    {!records.length && <p className="muted">No matching reviews. Unfetched details do not count as missing reviews.</p>}
    <div className="pagination"><span>50 rows per page · Page {current + 1} of {last + 1}</span><button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button><button disabled={current >= last} onClick={() => setPage(current + 1)}>Next</button></div>
  </section>;
}
export function ReviewAnalytics({ collection = false }: { collection?: boolean }) {
  const { records, sources, reviewFilters: filters, setReviewFilters: setFilters } = useApp();
  const [inspected, setInspected] = useState<AnnotationRecord | null>(null);
  const [grouping, setGrouping] = useState('project');
  const [selected, setSelected] = useState<string[]>([]);
  const scope = records;
  const filtered = useMemo(() => filterReviews(scope, filters), [scope, filters]);
  const stats = useMemo(() => summarizeReviews(filtered), [filtered]);
  const scored = useMemo(() => filtered.filter(record => reviewScore(record) !== null).sort((a, b) => reviewScore(a)! - reviewScore(b)!), [filtered]);
  const recent = useMemo(() => filtered.filter(record => record.detail?.data?.review.reviewed).sort((a, b) => (b.detail?.fetchedAt ?? '').localeCompare(a.detail?.fetchedAt ?? '')), [filtered]);
  const trend = useMemo(() => reviewGroups(filtered, r => (submittedDate(r) ?? r.createdAt ?? 'Unknown').slice(0, 10)).filter(group => group.name !== 'Unknown'), [filtered]);
  const grouped = useMemo(() => reviewGroups(filtered, record => grouping === 'pipeline' ? reviewPipeline(record) : grouping === 'iteration' ? record.iterationId ?? 'Unknown' : record.projectId ?? 'Unknown'), [filtered, grouping]);
  const change = (key: keyof ReviewFilters, value: string) => setFilters({ [key]: value });
  const options = (get: (record: AnnotationRecord) => string | null | undefined) => [...new Set(scope.map(get).filter((v): v is string => !!v))].sort();
  const partial = stats.collected < stats.total || stats.failed > 0 || !sources.length || sources.some(source => source.completeness !== 'complete');
  return <div className="review-page">
    <p className="notice">Local data source: saved annotations and verified review details in IndexedDB. Opening or filtering this view never fetches the platform. User-started ingestion updates this data independently. Task-answer analytics are separate in Results.</p>
    <p className="muted">Reviewer quality score range is unverified; no 1–5 assumption or conversion is applied.</p>
    {collection && <ReviewCollectionControls records={records} selected={selected} />}
    <section className="card filters" aria-label="Review filters">
      <div className="filter-top"><input className="review-search" aria-label="Search reviews" placeholder="Search ID, title, task ID or feedback..." value={filters.search} onChange={e => change('search', e.target.value)} /><button onClick={() => setFilters(emptyReviewFilters)}>Clear review filters</button><Badge>{filtered.length} matching / {scope.length} loaded in review scope</Badge></div>
      <details><summary>Review filters · {Object.entries(filters).filter(([key, value]) => key !== 'dateBasis' && value).length} active</summary><div className="filter-grid">
        <label className="field">Date basis<select value={filters.dateBasis} onChange={e => change('dateBasis', e.target.value)}><option value="created">Created date (UTC)</option><option value="submitted">Submitted / ended date (UTC)</option></select></label>
        <label className="field">Date from (UTC)<input type="date" value={filters.from} onChange={e => change('from', e.target.value)} /></label><label className="field">Date through (UTC)<input type="date" value={filters.to} onChange={e => change('to', e.target.value)} /></label>
        {([
          ['project', 'Project', options(r => r.projectId)], ['pipeline', 'Pipeline', options(reviewPipeline)], ['iteration', 'Iteration', options(r => r.iterationId)],
          ['state', 'Annotation state', options(r => r.state)], ['reviewStatus', 'Review status', options(r => r.detail?.data?.review.status)],
        ] as const).map(([key, label, values]) => <Select key={key} label={label} value={filters[key]} onChange={value => change(key, value)} options={values} />)}
        {(['exact', 'min', 'max'] as const).map(key => <label className="field" key={key}>{key === 'exact' ? 'Exact quality score' : key === 'min' ? 'Minimum quality score' : 'Maximum quality score'}<input type="number" step="any" value={filters[key]} onChange={e => change(key, e.target.value)} /></label>)}
        {([['hasReview', 'Has review'], ['hasScore', 'Has numeric quality score'], ['hasFeedback', 'Has reviewer feedback']] as const).map(([key, label]) => <label className="field" key={key}>{label}<select value={filters[key]} onChange={e => change(key, e.target.value)}><option value="">All</option><option value="yes">Yes</option><option value="no">No (collected details only)</option></select></label>)}
        <label className="field">Detail collection<select value={filters.collected} onChange={e => change('collected', e.target.value)}><option value="">All</option><option value="yes">Collected</option><option value="no">Not collected</option><option value="failed">Fetch failed</option></select></label>
      </div></details><p className="muted">All saved annotations are included, including list-only imports. Live collection eligibility does not hide local data. Unknown-origin imports require their original LinkedIn response URL before enrichment. "No review/score/feedback" excludes unfetched unknowns.</p>
    </section>
    <div className="collection-strip"><Badge good={!partial}>{partial ? 'Partial / unverified collection' : 'Details complete for loaded annotations'}</Badge><span>{stats.submitted} submitted · {stats.pending} awaiting enrichment · {stats.otherStatuses} other known statuses · {stats.unknownStatuses} unknown statuses</span></div>
    <div className="metrics">
      <Metric label="Total Annotations" value={stats.total.toLocaleString()} note="Matching review filters" accent /><Metric label="Details Collected" value={stats.collected.toLocaleString()} note="Successfully saved, including cached" />
      <Metric label="Reviewed" value={stats.reviewed.toLocaleString()} note="Current version review exists" /><Metric label="Approved" value={stats.approved.toLocaleString()} note="Known status APPROVED" />
      <Metric label="Average Annotation Score" value={stats.average === null ? 'Unknown' : stats.average.toFixed(2)} note={`${stats.scored} finite numeric scores only`} accent />
      <Metric label="Approval Rate" value={stats.approvalRate === null ? 'Unknown' : `${stats.approvalRate.toFixed(1)}%`} note={`${stats.approved} approved / ${stats.approvalDenominator} reviewed with known status`} />
      <Metric label="Missing Reviews" value={stats.missingReviews.toLocaleString()} note="Fetched, no current version review" /><Metric label="Fetch Failures" value={stats.failed.toLocaleString()} note="Failed records, not unknown reviews" />
    </div>
    <p className="muted">Quality score statistics · minimum {stats.min ?? 'Unknown'} · median {stats.median ?? 'Unknown'} · maximum {stats.max ?? 'Unknown'}. Partial summaries describe loaded records only.</p>
    {!scope.length && <Empty title="No saved annotations">Use Sources to import data or start authorized collection. The dashboard reads that saved data, including offline.</Empty>}
    <div className="chart-grid">
      <Distribution title="Annotation quality score distribution" data={stats.distribution} /><Distribution title="Review status distribution" data={stats.statuses} />
      <section className="card chart-card"><h3>Average quality score trend</h3><div className="chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={trend}>
        <CartesianGrid stroke="#263045" /><XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} /><YAxis tick={{ fill: '#94a3b8' }} /><Tooltip contentStyle={{ background: '#171d2d', border: '1px solid #36405a' }} /><Line isAnimationActive={false} dataKey="average" stroke="#22d3ee" connectNulls={false} />
      </LineChart></ResponsiveContainer></div><p className="muted">Annotation ended date, otherwise creation date; not an inferred review timestamp.</p></section>
      <Distribution title="Annotation throughput by date" data={trend.map(day => ({ name: day.name, count: day.total }))} />
      <section className="card wide"><div className="section-heading"><h3>Average quality score by group</h3><select aria-label="Review grouping" value={grouping} onChange={e => setGrouping(e.target.value)}><option value="project">Project</option><option value="iteration">Iteration</option><option value="pipeline">Pipeline</option></select></div><div className="distribution-list">{grouped.map(group => <div key={group.name}><span>{group.name}</span><b>{group.average === null ? 'Unknown' : group.average.toFixed(3)} · {group.scored} scored / {group.total} annotations</b></div>)}</div></section>
    </div>
    <ReviewTable records={filtered} inspect={setInspected} selected={selected} select={setSelected} />
    <div className="source-layout">{[
      ['Lowest-scoring annotations (observed bottom 10)', scored.slice(0, 10)],
      ['Highest-scoring annotations (observed top 10)', [...scored].reverse().slice(0, 10)],
      ['Recent reviews (last observed, not review date)', recent.slice(0, 10)],
    ].map(([title, items]) => <section className="card" key={String(title)}><h3>{String(title)}</h3>{(items as AnnotationRecord[]).map(record => <button className="recent-row" key={record.key} onClick={() => setInspected(record)}><b>{record.id} · {record.title ?? 'Untitled'} · {reviewScore(record) ?? 'No score'}</b><small>{record.detail?.data?.review.feedback?.slice(0, 180) ?? 'No feedback'}</small></button>)}</section>)}
      <section className="card"><h3>Repeated feedback patterns</h3><p className="muted">Exact text, case/whitespace normalized. No inferred reviewer identities or AI categorization.</p><div className="distribution-list">{stats.feedbackPatterns.slice(0, 20).map(pattern => <div key={pattern.feedback}><span>{pattern.feedback.slice(0, 300)}</span><b>{pattern.count}</b></div>)}</div></section>
    </div>
    {inspected && <Feedback record={inspected} onClose={() => setInspected(null)} />}
  </div>;
}
