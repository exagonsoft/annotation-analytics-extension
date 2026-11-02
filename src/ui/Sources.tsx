import { useEffect, useRef, useState } from 'react';
import { FileUp, Network, Play, Square, RefreshCw, Globe, PanelRight } from 'lucide-react';
import { collectApi } from '../collectors/api';
import { importData } from '../collectors/import';
import { endpointUrl } from '../core/privacy';
import { saveSettings } from '../core/storage';
import type { Source } from '../core/model';
import { Badge } from './components';
import { action, useApp } from './store';
import { targetTab } from '../collectors/target-tab';
import { ReviewCollectionControls } from './ReviewAnalytics';

export { targetTab } from '../collectors/target-tab';
export async function setCapture(enabled: boolean): Promise<void> {
  await chrome.storage.session.set({ [`capture:${await targetTab()}`]: enabled });
}
export async function startDom(): Promise<void> {
  const tabId = await targetTab();
  await chrome.storage.session.set({ [`dom:${tabId}`]: true });
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['assets/dom.js'] }); } catch {
    await chrome.storage.session.set({ [`dom:${tabId}`]: false });
    throw new Error('Cannot read this tab. Open the extension popup on the target website and start DOM capture there.');
  }
}
export async function stopDom(): Promise<void> {
  const tabId = await targetTab();
  await chrome.storage.session.set({ [`dom:${tabId}`]: false });
  try { await chrome.tabs.sendMessage(tabId, { type: 'STOP_DOM' }); } catch {
    // A navigated or closed tab has no content script to stop.
  }
}
export function Sources({ panel = false }: { panel?: boolean }) {
  const { sources, settings, records } = useApp();
  const [endpoint, setEndpoint] = useState(settings.endpoint);
  const [maxPages, setMaxPages] = useState(settings.pageLimit);
  const [delay, setDelay] = useState(settings.delayMs);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Source | null>(null);
  const [capture, setCapturing] = useState(false);
  const [dom, setDom] = useState(false);
  const [notice, setNotice] = useState('');
  const [related, setRelated] = useState(false);
  const [arrayPath, setArrayPath] = useState('');
  const [resultIdPath, setResultIdPath] = useState('');
  const [annotationIdPath, setAnnotationIdPath] = useState('id');
  const [targetStatus, setTargetStatus] = useState('Select a website using the extension popup, or open this DevTools panel on that website.');
  const [importOrigin, setImportOrigin] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => controller.current?.abort();
  }, []);
  useEffect(() => { setEndpoint(settings.endpoint); setMaxPages(settings.pageLimit); setDelay(settings.delayMs); }, [settings.endpoint, settings.pageLimit, settings.delayMs]);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const id = await targetTab();
      if (disposed) return;
      setTargetStatus(`Selected website tab: ${id}`);
      const read = async () => {
        const flags = await chrome.storage.session.get([`capture:${id}`, `dom:${id}`]);
        if (!disposed) { setCapturing(flags[`capture:${id}`] === true); setDom(flags[`dom:${id}`] === true); }
      };
      await read();
      if (disposed) return;
      const listener = () => { void read().catch(useApp.getState().report); };
      chrome.storage.onChanged.addListener(listener);
      cleanup = () => chrome.storage.onChanged.removeListener(listener);
    })().catch(error => { if (!disposed) setTargetStatus(error instanceof Error ? error.message : 'Select a website tab before starting capture.'); });
    return () => { disposed = true; cleanup(); };
  }, []);
  async function fetchAll() {
    if (running) return;
    const url = endpointUrl(endpoint);
    if (related && (!resultIdPath.trim() || !annotationIdPath.trim())) throw new Error('Configure both verified join identity paths.');
    // Invoke permission request before an await so Chrome retains the user gesture.
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) throw new Error('Host permission was not granted. Use DevTools capture or import instead.');
    await saveSettings({ ...settings, endpoint: url.href, pageLimit: maxPages, delayMs: delay });
    const abort = new AbortController();
    controller.current = abort; setRunning(true); setNotice('');
    try {
      const source = await collectApi({
        endpoint: url.href, maxPages, delayMs: delay, mappings: settings.mappings, signal: abort.signal,
        onProgress: setProgress,
        join: related ? { arrayPath: arrayPath.trim(), resultIdPath: resultIdPath.trim(), annotationIdPath: annotationIdPath.trim() } : undefined,
      });
      setNotice(source.completeness === 'complete' ? 'Collection ended with a verified terminal condition. Compare the scoped server total below.' : 'Collection is incomplete. See source diagnostics; completed pages were retained.');
    } finally { setRunning(false); controller.current = null; }
  }
  return <div className="source-layout">
    <div className="wide"><ReviewCollectionControls records={records} selected={[]} /></div>
    <section className="card"><div className="section-heading"><h3><Network size={18} />DevTools Network capture</h3><Badge good={capture}>{capture ? 'Armed' : 'Stopped'}</Badge></div>
      <p>Open Chrome DevTools on the annotation website, find the <b>Annotation Analytics</b> panel, start capture, then reload or navigate the task list. Only future completed JSON requests are inspected.</p>
      <div className="toolbar"><button className="primary" onClick={() => void action(async () => { await setCapture(true); setCapturing(true); })}><Play size={15} />Start capture</button><button onClick={() => void action(async () => { await setCapture(false); setCapturing(false); })}><Square size={14} />Stop capture</button></div>
      {!panel && <p className="muted">Arming capture does not open DevTools. DevTools must remain open on the selected website tab. No authentication headers or cookies are read.</p>}
      <p className="muted">{targetStatus}</p>
    </section>
    <section className="card"><div className="section-heading"><h3><Globe size={18} />Authorized API connector</h3><Badge>GET · session cookies</Badge></div>
      <p>Paste a verified task-list endpoint from DevTools. Only the exact origin is requested. Browser cookie policies still apply; this connector cannot bypass login, CORS or access controls.</p>
      <label className="field">Endpoint, including existing filters and first-page query<input placeholder="https://your-platform.example/api/tasks?page=1" value={endpoint} onChange={e => setEndpoint(e.target.value)} disabled={running} /></label>
      <div className="filter-grid"><label className="field">Maximum pages (1–1000)<input type="number" min={1} max={1000} value={maxPages} onChange={e => setMaxPages(Math.max(1, Math.min(1000, Number(e.target.value))))} /></label><label className="field">Delay between pages (ms)<input type="number" min={100} max={30000} value={delay} onChange={e => setDelay(Math.max(100, Math.min(30000, Number(e.target.value))))} /></label></div>
      <details><summary>Related result endpoint (explicit identity join)</summary><label className="toolbar"><input type="checkbox" checked={related} onChange={e => setRelated(e.target.checked)} />Join result objects to already loaded annotations</label>
        {related && <><div className="filter-grid"><label className="field">Result array path (empty for root array)<input value={arrayPath} onChange={e => setArrayPath(e.target.value)} placeholder="data.results" /></label><label className="field">Result identity path<input value={resultIdPath} onChange={e => setResultIdPath(e.target.value)} placeholder="annotationId" /></label><label className="field">Matching path in annotation raw JSON<input value={annotationIdPath} onChange={e => setAnnotationIdPath(e.target.value)} placeholder="id" /></label></div><p className="warning">Only records from the same origin are joined. Verify the relationship yourself. Duplicate annotation IDs across projects are skipped. For task-level joins, use a verified task identity and task-level score mapping. Result fields are attached at relatedResult.</p></>}
      </details>
      <div className="toolbar"><button className="primary" disabled={running || !endpoint} onClick={() => void action(fetchAll)}><RefreshCw size={15} />{running ? 'Collecting…' : 'Fetch all available pages / refresh'}</button><button disabled={!running} onClick={() => controller.current?.abort()}><Square size={14} />Cancel</button></div>
      <p className="muted">Pagination is followed only when response metadata identifies a supported mechanism. At most three attempts per retryable HTTP response. Redirects and cross-origin next links are refused.</p>
      {progress && <div className="progress-stats">{[['Requests completed', progress.requests], ['Pages collected', progress.pages], ['Records received', progress.received], ['Unique this run', progress.uniqueRecords], ['Stored overlaps / duplicates', progress.duplicates], ['Collection failures', progress.errors], ['Method', progress.method]].map(([label, count]) => <div key={label}><small>{label}</small><b>{count}</b></div>)}</div>}
    </section>
    <section className="card"><div className="section-heading"><h3><PanelRight size={18} />Rendered-page fallback</h3><Badge good={dom}>{dom ? 'Observing' : 'Stopped'}</Badge></div>
      <p>Reads rendered tables with explicit ID, title and status headers, or elements with task ID attributes. An observer handles dynamically rendered rows. Explicitly labeled scores are available at <code>annotationData.renderedScores</code> for manual mapping.</p>
      <div className="toolbar"><button onClick={() => void action(async () => { await startDom(); setDom(true); })}>Start DOM collector</button><button onClick={() => void action(async () => { await stopDom(); setDom(false); })}>Stop DOM collector</button></div><p className="warning">Rendered rows are always a partial collection, never a global total.</p>
    </section>
    <section className="card"><h3><FileUp size={18} />Import saved responses</h3><p>Import JSON, JSONL, exported annotations, or a snapshot. Nested JSON strings are decoded. Sensitive fields are redacted before persistence. Maximum file size: 50 MB.</p>
      <label className="field">Original response URL (optional)<input placeholder="https://your-platform.example/api/tasks" value={importOrigin} onChange={e => setImportOrigin(e.target.value)} /><small>Set this to deduplicate saved raw responses against records captured from that origin. Without it, raw imports use a separate unknown-origin namespace.</small></label>
      <label className="file-input">Choose JSON / JSONL<input type="file" accept=".json,.jsonl,application/json" onChange={e => {
        const file = e.target.files?.[0]; e.target.value = '';
        if (file) void action(async () => {
          if (file.size > 50_000_000) throw new Error('File exceeds the 50 MB import limit.');
          if (importOrigin) endpointUrl(importOrigin);
          const count = await importData(await file.text(), settings.mappings, importOrigin);
          setNotice(`Imported ${count} new unique annotations. Overlapping records were deduplicated.`);
        });
      }} /></label><p className="muted">Standalone result objects require an explicit identity join through the related-result API connector; IDs are never guessed from titles.</p>
    </section>
    {notice && <p role="status" className="notice">{notice}</p>}
    <section className="card wide"><h3>Recognized sources & diagnostics</h3><p className="muted">Server totals are per response scope. They are never added together across overlapping endpoints or filters.</p>
      {!sources.length ? <p className="muted">No recognized requests or imports yet.</p> : <div className="source-list">{sources.map(source => <article key={source.id}><div className="section-heading"><div><Badge>{source.method}</Badge><b>{source.url || 'Local file'}</b><small>{new Date(source.collectedAt).toLocaleString()} · {source.httpMethod ?? '—'} {source.status ?? ''}</small></div><Badge good={source.completeness === 'complete'}>{source.completeness}</Badge></div><p>{source.received} received · {source.pages} pages · {source.duplicates} duplicates · {source.errors} errors · <b>{source.reportedTotal ?? 'Unknown'} reported by server</b></p>{source.diagnostics.map((diagnostic, index) => <p className="muted" key={index}>{diagnostic}</p>)}</article>)}</div>}
    </section>
  </div>;
}
