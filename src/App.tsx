import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowUpRight, BarChart3, Database, Download, History as HistoryIcon, Layers, LayoutDashboard, Network, PanelRight, Settings as SettingsIcon, ShieldCheck, Wallet, X } from 'lucide-react';
import { filterRecords, hasScore, scoreSummary, summarize } from './core/analytics';
import { download, exportRecords, exportStructured } from './core/export';
import { clearCurrent, saveSnapshot } from './core/storage';
import { emptyFilters } from './core/model';
import { emptyReviewFilters, filterReviews, reviewCsv, reviewScore, summarizeReviews } from './core/review-analytics';
import { hasCachedDetail } from './core/review';
import { Analytics } from './ui/Analytics';
import { Annotations, Detail } from './ui/Annotations';
import { Badge, FilterBar, Modal } from './ui/components';
import { History } from './ui/History';
import { Sources, setCapture, startDom } from './ui/Sources';
import { Settings } from './ui/Settings';
import { ReviewAnalytics } from './ui/ReviewAnalytics';
import { ReviewCacheSummary } from './ui/ReviewCacheSummary';
import { action, initialize, useApp } from './ui/store';
import { FinancialExport, Financials, FinancialSummary } from './ui/Financials';
import { annotationPaymentCoverage } from './core/finance';

const navigation = [
  { name: 'Dashboard', icon: LayoutDashboard }, { name: 'Annotations', icon: Layers },
  { name: 'Results', icon: BarChart3 }, { name: 'Sources', icon: Network },
  { name: 'Review Analytics', icon: ShieldCheck },
  { name: 'Financials', icon: Wallet },
  { name: 'History', icon: HistoryIcon }, { name: 'Settings', icon: SettingsIcon },
] as const;
type Page = typeof navigation[number]['name'];
function ExportDialog({ onClose, reviews }: { onClose: () => void; reviews: boolean }) {
  const { records, filters, reviewFilters, settings, sources, payments } = useApp();
  const [scope, setScope] = useState('filtered');
  const [format, setFormat] = useState<'csv' | 'json' | 'jsonl'>('csv');
  const data = scope === 'all' ? records : reviews ? filterReviews(records, reviewFilters) : filterRecords(records, filters, payments);
  return <Modal title="Export local data" onClose={onClose} description="Exports contain redacted data only. Review free-text fields before sharing.">
    <div className="filter-grid"><label className="field">Scope<select value={scope} onChange={e => setScope(e.target.value)}><option value="filtered">Filtered annotations ({data.length})</option><option value="all">All annotations ({records.length})</option><option value="summary">Summary statistics</option><option value="distributions">Score distributions</option><option value="snapshot">Current snapshot</option></select></label><label className="field">Format<select value={format} onChange={e => setFormat(e.target.value as typeof format)}><option value="csv">CSV</option><option value="json">JSON</option><option value="jsonl">JSONL</option></select></label></div>
    <p className="muted">Statistics and distributions use current filters. CSV formula-like cells are prefixed with an apostrophe.</p>
    <button className="primary" onClick={() => {
      if (scope === 'summary' || scope === 'distributions' || scope === 'snapshot') {
        const content = scope === 'summary' ? reviews ? summarizeReviews(data) : summarize(data) : scope === 'distributions' ?
          reviews ? { qualityScores: summarizeReviews(data).distribution, reviewStatuses: summarizeReviews(data).statuses } :
          Object.fromEntries((['aesthetics', 'functionality', 'overall'] as const).map(d => [d, scoreSummary(data, d)])) :
          { schemaVersion: 2, id: crypto.randomUUID(), name: 'Exported snapshot', createdAt: new Date().toISOString(), records, sources, mappings: settings.mappings };
        download(exportStructured(content, format), `annotation-${scope}.${format}`, format === 'csv' ? 'text/csv' : format === 'jsonl' ? 'application/x-ndjson' : 'application/json');
      } else download(reviews && format === 'csv' ? reviewCsv(data) : exportRecords(data, format,
        reviews ? undefined : annotationPaymentCoverage(records, payments)), `annotations-${scope}.${format}`, format === 'csv' ? 'text/csv' : format === 'jsonl' ? 'application/x-ndjson' : 'application/json');
      onClose();
    }}><Download size={15} />Download {format.toUpperCase()}</button>
  </Modal>;
}
function Compact({ sidepanel }: { sidepanel: boolean }) {
  const { records, sources, reviewRuns } = useApp();
  const [site, setSite] = useState('No website selected');
  const [tabId, setTab] = useState<number>();
  const [capture, setCapturing] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [detail, setDetail] = useState<(typeof records)[number] | null>(null);
  const ingestion = reviewRuns.find(run => run.status === 'running');
  useEffect(() => {
    void action(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id && tab.url?.startsWith('http')) {
        setSite(new URL(tab.url).hostname); setTab(tab.id);
        await chrome.storage.session.set({ targetTab: tab.id });
        setCapturing((await chrome.storage.session.get(`capture:${tab.id}`))[`capture:${tab.id}`] === true);
      }
    });
  }, []);
  function openDashboard(view?: 'reviews' | 'results' | 'sources' | 'financials', taskAnswers = false) {
    const params = new URLSearchParams();
    if (tabId) params.set('tab', String(tabId));
    if (view) params.set('view', view);
    if (taskAnswers) params.set('data', 'answers');
    void action(() => chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${params.size ? `?${params}` : ''}`) }));
  }
  return <div className={`compact ${sidepanel ? 'sidepanel' : ''}`}>
    <div className="brand"><div className="brand-mark"><Activity size={21} /></div><div>Annotation<span>ANALYTICS</span></div><Badge>LOCAL</Badge></div>
    <div className="compact-site"><span className="dot" />{site}</div>
    <div className="section-heading"><span className="muted">Local data source · IndexedDB</span><Badge good>Saved data</Badge></div>
    <div className="compact-count"><strong>{records.length.toLocaleString()}</strong><span>saved unique annotations</span></div>
    <ReviewCacheSummary records={records} compact onOpenReviews={() => openDashboard('reviews')} />
    <FinancialSummary onOpen={() => openDashboard('financials')} />
    <p className="muted">{ingestion ? `Background ingestion: ${ingestion.completed} saved, ${ingestion.failed} failed. You can close this popup.` : 'Reads saved data offline. Collection runs only when you start it in Sources.'}</p>
    <button className="primary full" onClick={() => openDashboard()}>Open analytics dashboard<ArrowUpRight size={16} /></button>
    <div className="toolbar"><button onClick={() => openDashboard('sources')}>Data sources / collection</button><button onClick={() => openDashboard('results', true)}>Task-answer results</button><button onClick={() => openDashboard('financials')}>Financials</button></div>
    <div className="section-heading"><span className="muted">Optional network capture</span><Badge good={capture}>{capture ? 'Armed · DevTools required' : 'Stopped'}</Badge></div>
    <div className="toolbar"><button onClick={() => void action(async () => { await setCapture(!capture); setCapturing(!capture); })}>{capture ? 'Stop capture' : 'Arm capture'}</button><button onClick={() => setInstructions(true)}>DevTools instructions</button></div>
    <div className="toolbar"><button onClick={() => void action(startDom)}>Collect DOM rows</button>{!sidepanel && <button onClick={() => void action(async () => { if (!tabId) throw new Error('Open the popup on a website first.'); await chrome.sidePanel.open({ tabId }); window.close(); })}><PanelRight size={14} />Side panel</button>}</div>
    {sidepanel && <section><h3>Recent annotations</h3>{records.slice().sort((a, b) => b.source.collectedAt.localeCompare(a.source.collectedAt)).slice(0, 10).map(record => <button className="recent-row" key={record.key} onClick={() => setDetail(record)}><b>{record.title ?? record.id}</b><small>{record.state ?? 'Unknown'} · Review score: {reviewScore(record) ?? 'Unknown'}</small></button>)}{!records.length && <p className="muted">Collected results will appear here.</p>}</section>}
    <footer><ShieldCheck size={13} />On-device only · {sources.some(s => s.completeness !== 'complete') || !sources.length ? 'Partial / unverified totals' : 'Check scoped server totals'}</footer>
    {instructions && <Modal title="Enable DevTools capture" onClose={() => setInstructions(false)} description="Chrome only exposes response bodies while DevTools is open."><p>On your annotation website, press F12 or Ctrl+Shift+I. Select the Annotation Analytics DevTools panel (it may be in the overflow menu). Click Start capture, then reload or navigate the task list.</p><p>Keep DevTools open. Requests completed before capture starts cannot be recovered. The extension service worker does not intercept response bodies.</p></Modal>}
    {detail && <Detail record={detail} onClose={() => setDetail(null)} />}
  </div>;
}
export default function App() {
  const { records, filters, ready, error, settings, reviewRuns, payments } = useApp();
  const [page, setPage] = useState<Page>(() => {
    const view = new URLSearchParams(location.search).get('view');
    return view === 'reviews' ? 'Review Analytics' : view === 'results' ? 'Results' : view === 'sources' ? 'Sources' : view === 'financials' ? 'Financials' : 'Dashboard';
  });
  const [exporting, setExporting] = useState(false);
  const [resultsChoice, setResultsChoice] = useState<'reviews' | 'answers' | null>(() =>
    new URLSearchParams(location.search).get('data') === 'answers' ? 'answers' : null);
  const resultsMode = resultsChoice ?? (records.some(hasCachedDetail) || !records.some(hasScore) ? 'reviews' : 'answers');
  const reviewsView = page === 'Dashboard' || page === 'Review Analytics' || page === 'Results' && resultsMode === 'reviews';
  const pathname = location.pathname;
  const compact = pathname.endsWith('popup.html') || pathname.endsWith('sidepanel.html');
  const panel = pathname.endsWith('panel.html') && !pathname.endsWith('sidepanel.html');
  const filtered = useMemo(() => filterRecords(records, filters, payments), [records, filters, payments]);
  useEffect(initialize, []);
  return <>
    {error && <div role="alert" className="error-banner"><b>Action failed</b><span>{error}</span><button aria-label="Dismiss error" onClick={() => useApp.setState({ error: '' })}><X size={15} /></button></div>}
    {!ready ? <div className="loading" role="status">Opening local annotation database…</div> : compact ? <Compact sidepanel={pathname.endsWith('sidepanel.html')} /> : <div className="app-shell">
      <aside className="sidebar"><div className="brand"><div className="brand-mark"><Activity size={24} /></div><div>Annotation<span>ANALYTICS</span></div></div><div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">{navigation.map(({ name, icon: Icon }) => <button aria-label={name} className={page === name && !panel || panel && name === 'Sources' ? 'active' : ''} key={name} onClick={() => { if (panel) { void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?tab=${chrome.devtools.inspectedWindow.tabId}${name === 'Review Analytics' ? '&view=reviews' : name === 'Financials' ? '&view=financials' : ''}`) }); } else setPage(name); }}><Icon size={18} />{name}{name === 'Annotations' && <span>{records.length.toLocaleString()}</span>}</button>)}</nav>
        <div className="sidebar-bottom"><div><ShieldCheck size={17} /><b>Private by design</b></div><p>Your records stay on this device. No telemetry. No cloud.</p><Badge>Manifest V3 · v1.0</Badge></div>
      </aside>
      <main><header><div className="breadcrumb">Workspace <span>/</span> {panel ? 'Network capture' : page}</div>{!panel && <select className="mobile-nav" aria-label="Page" value={page} onChange={e => setPage(e.target.value as Page)}>{navigation.map(n => <option key={n.name}>{n.name}</option>)}</select>}<div className="toolbar"><Badge><span className="dot" />Local workspace</Badge><button onClick={() => setExporting(true)}><Download size={15} />Export</button></div></header>
        <div className="page-content"><div className="page-title"><div><div className="eyebrow">{panel ? 'DEVTOOLS NETWORK' : 'ANNOTATION INTELLIGENCE'}</div><h1>{panel ? 'Network capture' : page === 'Review Analytics' ? 'Review Analytics' : page === 'Financials' ? 'Financials' : page === 'Dashboard' ? 'Your annotation overview' : page === 'Annotations' ? 'Annotation explorer' : page === 'Results' ? 'Evaluation results' : page === 'Sources' ? 'Data collection' : page === 'History' ? 'Snapshot history' : 'Workspace settings'}</h1><p>{panel ? 'Inspect supported JSON responses from the selected website.' : page === 'Dashboard' ? 'Understand your workload. Explore real results. Trust your numbers.' : 'Local data, explicit scores, and transparent collection scope.'}</p></div>
          {['Dashboard', 'Annotations', 'Results'].includes(page) && !panel && <button className="primary" onClick={() => setPage('Sources')}><Database size={16} />Collect data</button>}
        </div>
        {!panel && <div className="collection-strip"><Badge>IndexedDB · source of truth</Badge><span>{records.length.toLocaleString()} saved annotations · no live fetch on view</span>{reviewRuns.find(run => run.status === 'running') && <span role="status">Background ingestion running · {reviewRuns.find(run => run.status === 'running')!.completed} saved</span>}</div>}
        {!panel && page === 'Results' && <section className="card" aria-label="Results data source"><div className="toolbar" role="group" aria-label="Result type"><button aria-pressed={resultsMode === 'reviews'} onClick={() => setResultsChoice('reviews')}>Reviewer scores</button><button aria-pressed={resultsMode === 'answers'} onClick={() => setResultsChoice('answers')}>Task answers</button></div><p className="muted">{resultsMode === 'reviews' ? 'Saved currentVersionReview.annotationScore, review status and feedback. These are the scores collected during enrichment.' : 'Mapped Overall, Aesthetics and Functionality answers only. Reviewer scores are a different result and are never substituted here.'}</p></section>}
        {!panel && (page === 'Annotations' || page === 'Results' && !reviewsView) && <FilterBar />}
        {!panel && page === 'Dashboard' && <FinancialSummary onOpen={() => setPage('Financials')} />}
        {panel ? <Sources panel /> : page === 'Financials' ? <Financials /> : page === 'Review Analytics' ? <ReviewAnalytics collection /> : reviewsView ? <ReviewAnalytics /> : page === 'Results' ? <Analytics records={filtered} results onOpenReviews={() => setResultsChoice('reviews')} /> : page === 'Annotations' ? <Annotations records={filtered} /> : page === 'Sources' ? <Sources /> : page === 'History' ? <History /> : <Settings />}
        {!panel && ['Dashboard', 'Annotations', 'Results', 'Review Analytics'].includes(page) && <div className="bottom-actions"><button onClick={() => { const name = window.prompt('Snapshot name'); if (name !== null) void action(() => saveSnapshot(name, settings.mappings)); }}>Save snapshot</button><button onClick={() => reviewsView ? useApp.getState().setReviewFilters(emptyReviewFilters) : useApp.getState().setFilters(emptyFilters)}>Reset filters</button><button className="danger" onClick={() => { if (window.confirm('Clear current annotations, sources and cached review details? Saved snapshots remain. Stop collectors first.')) void action(clearCurrent); }}>Clear current results</button></div>}
        <footer><ShieldCheck size={14} />Local-first analytics. Loaded records are not a global total unless verified against the same server scope.</footer>
        </div>
      </main>
    </div>}
    {exporting && (page === 'Financials' ? <FinancialExport onClose={() => setExporting(false)} /> : <ExportDialog reviews={reviewsView} onClose={() => setExporting(false)} />)}
  </>;
}
