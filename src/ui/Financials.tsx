import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Wallet } from 'lucide-react';
import { batchName, cents, exactSum, financialProjection, financialSummary, GREENLIGHT_PORTAL, observedBatchEarnings, reconcileFinancialBatches, usd, type Payment } from '../core/finance';
import { clearFinancialData, ingestFinancialTime, saveFinancialMapping } from '../core/finance-storage';
import { csvCell, download, exportStructured } from '../core/export';
import { db, rebuildBatchJoins } from '../core/storage';
import { armGreenlightCapture, collectGreenlightDom, collectPreviousGreenlightWeek, greenlightCaptureKey, greenlightTabs, type GreenlightCaptureState } from '../collectors/greenlight';
import { Badge, Empty, Metric, Modal } from './components';
import { action, emptyFinancialFilters, useApp, type FinancialFilters } from './store';

export function filterPayments(payments: Payment[], filters: FinancialFilters): Payment[] {
  const query = filters.search.trim().toLowerCase();
  return payments.filter(payment => (!query || `${payment.tag} ${payment.notes}`.toLowerCase().includes(query)) &&
    (!filters.from || payment.date >= filters.from) && (!filters.to || payment.date <= filters.to) &&
    (!filters.status || (payment.status === 4 ? 'paid' : 'pending') === filters.status) &&
    (!filters.tag || payment.tag === filters.tag) && (!filters.organization || payment.organizationId === filters.organization));
}
export function financialCsv(payments: Payment[]): string {
  return '\uFEFF' + ['deliverable_id,date,engagement_id,tag,currency,amount,payment_state,raw_status,annotation_count,review_count,count_warning,notes',
    ...payments.map(payment => [payment.id, payment.date, payment.engagementId, payment.tag, 'USD', (payment.amountCents / 100).toFixed(2),
      payment.status === 4 ? 'Paid / Processed' : 'Pending', payment.status,
      payment.countWarning ? null : payment.batches.reduce((sum, batch) => sum + batch.annotations, 0),
      payment.countWarning ? null : payment.batches.reduce((sum, batch) => sum + batch.reviews, 0),
      payment.countWarning, payment.notes].map(csvCell).join(','))].join('\r\n');
}
export function FinancialExport({ onClose }: { onClose: () => void }) {
  const { payments, financialFilters, financialPeriods, financialDom, financialMappings, records } = useApp();
  const [format, setFormat] = useState<'csv' | 'json' | 'jsonl'>('csv');
  const [scope, setScope] = useState('filtered');
  const rows = scope === 'all' ? payments : filterPayments(payments, financialFilters);
  return <Modal title="Export financial data" description="Financial records and notes stay local. Review them before sharing. Annotation snapshots do not include the separate financial cache." onClose={onClose}>
    <div className="filter-grid"><label className="field">Scope<select value={scope} onChange={event => setScope(event.target.value)}><option value="filtered">Filtered deliverables ({rows.length})</option><option value="all">All deliverables ({payments.length})</option><option value="summary">Filtered payment summary</option></select></label>
      <label className="field">Format<select value={format} onChange={event => setFormat(event.target.value as typeof format)}><option value="csv">CSV</option><option value="json">JSON</option><option value="jsonl">JSONL</option></select></label></div>
    <button className="primary" onClick={() => {
      const reconciliation = reconcileFinancialBatches(payments, records);
      const value = scope === 'summary' ? financialSummary(rows) : format === 'json' ? { schemaVersion: 1, currency: 'USD', payments: rows, financialPeriods, financialDom, financialMappings,
        estimateScope: 'Complete saved annotation and financial cache', reconciliation, observedBatchEarnings: observedBatchEarnings(payments, reconciliation) } : rows;
      const content = scope === 'summary' ? exportStructured(value, format) : format === 'csv' ? financialCsv(rows) :
        format === 'jsonl' ? rows.map(payment => JSON.stringify(payment)).join('\n') : exportStructured(value, 'json');
      download(content, `financials-${scope}.${format}`, format === 'csv' ? 'text/csv' : format === 'jsonl' ? 'application/x-ndjson' : 'application/json');
      onClose();
    }}>Download {format.toUpperCase()}</button>
    <p className="muted">USD totals use integer cents. Unrecognized notes retain their amount but do not invent task counts. Exported normalized JSON is a report, not a raw Greenlight response for import.</p>
  </Modal>;
}
export function FinancialSummary({ onOpen }: { onOpen?: () => void }) {
  const { payments, financialDom, financialPeriods, records, financialMappings } = useApp();
  if (!financialPeriods.length && !financialDom.length && !records.some(record => record.state === 'SUBMITTED' && record.source.url.startsWith('https://www.linkedin.com/'))) return null;
  const api = financialPeriods.length > 0, dom = financialDom[0];
  const summary = financialSummary(payments);
  const projections = financialProjection(payments, records, financialMappings);
  const reconciliation = reconcileFinancialBatches(payments, records);
  const observed = observedBatchEarnings(payments, reconciliation);
  const projected = exactSum(projections.map(row => row.projectedCents ?? 0));
  const domAmount = (paid: boolean) => exactSum(dom?.rows.filter(row => (row.status.toLowerCase() === 'processed') === paid).map(row => row.amountCents) ?? []);
  return <section className="card" aria-label="Cached financial summary">
    <div className="section-heading"><h3><Wallet size={16} /> Financials · USD</h3><Badge>Local cache</Badge></div>
    <div className="metrics">
      <Metric label="Paid earnings" value={api || dom ? usd(api ? summary.paidCents : domAmount(true)) : 'Not collected'} note={api ? `${summary.paidEntries} processed deliverables` : 'Rendered week only · no API ledger'} accent />
      <Metric label="Pending payments" value={api || dom ? usd(api ? summary.pendingCents : domAmount(false)) : 'Not collected'} note="Actual ledger/DOM amounts only; unbilled estimates are separate" />
      <Metric label="Paid annotation tasks" value={api ? String(summary.paidAnnotations) : 'Not available'} note={api ? 'Att counts, including correction deltas' : 'DOM rows do not expose task counts'} />
      <Metric label="Pending annotation tasks" value={api ? String(summary.pendingAnnotations) : 'Not available'} note={api ? 'Att counts in pending deliverables' : 'Capture the native time JSON for counts'} />
      <Metric label="Completed attempts not in ledger (estimate)" value={String(reconciliation.unaccountedAttempts)} note={`${reconciliation.rows.filter(row => row.unaccountedAttempts === null).length} uncertain batches and ${reconciliation.missingMetadata} records without batch metadata excluded`} />
      <Metric label="Completed reviews not in ledger (estimate)" value={String(reconciliation.unaccountedReviews)} note="Review work counted separately; no inferred reviewer rate" />
      <Metric label="Tasks awaiting payment reconciliation" value={String(reconciliation.missingMetadata)} note="Submitted records lacking batch metadata; not classified as paid or unpaid" />
      <Metric label="Remaining cached attempts to pay (estimate)" value={String(reconciliation.remainingToPayAttempts)} note="Joined batch submitted attempts − paid Att counts; uncertain batches excluded" />
      {api && <Metric label="Total pending attempts (estimate)" value={String(exactSum([summary.pendingAnnotations, reconciliation.unaccountedAttempts]))} note="Pending Greenlight Att counts + completed attempts absent from saved ledger" />}
      {api && <Metric label="Remaining earnings estimate (observed batch rates)" value={observed.availableEstimates || !observed.unavailableEstimates && !reconciliation.missingMetadata ? usd(observed.remainingCents) : 'Not available'}
        note={`Same-batch paid USD ÷ attributable paid tasks × remaining work; ${observed.unavailableEstimates} batch/work-type estimates unavailable and ${reconciliation.missingMetadata} records without metadata excluded. Known-rate subtotal; includes pending work.`} />}
      {api && <Metric label="Pending + unbilled estimate (observed rates)" value={usd(exactSum([summary.pendingCents, observed.unaccountedCents]))}
        note={`Actual pending ledger + observed-rate unaccounted work only; ${observed.unavailableEstimates} batch/work-type estimates unavailable and ${reconciliation.missingMetadata} records without metadata excluded. Not added to other estimates.`} />}
      {api && !!projections.length && <Metric label="Unbilled earnings estimate" value={usd(projected)} note={`${projections.filter(row => row.uncertain).length} uncertain mappings excluded`} />}
      {api && !!projections.length && <Metric label="To be earned / received estimate" value={usd(exactSum([summary.pendingCents, projected]))} note="Pending ledger + mapped unbilled work; incomplete history can overstate" />}
    </div>
    <p className="muted">{api ? `${financialPeriods.length} captured period responses. Totals cover saved deliverables only; missing weeks are not proof of no payment.` : dom ? `${dom.period}. DOM observations are a separate fallback and never added to API totals.` : 'No financial ledger captured; completed work absent from this cache is not proof of unpaid work.'} Unaccounted work can be overstated by missing payment periods. {summary.unknownCounts ? `${summary.unknownCounts} deliverables have unknown task counts.` : ''} Reads financial cache only; annotation filters do not change these totals.</p>
    {api && <p className="muted">{reconciliation.rows.filter(row => row.status === 'matched').length} / {reconciliation.rows.filter(row => row.status !== 'no-payment').length} payment batches matched to cached annotation pipelines. {reconciliation.rows.filter(row => row.status === 'no-payment').length} cached batches have no saved deliverable. {reconciliation.missingMetadata} submitted records lack a cached batch name or identity. Matching establishes batch counts, not individual paid IDs.</p>}
    {onOpen && <button onClick={onOpen}>Open Financials</button>}
  </section>;
}
function FinancialCollection() {
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [tabId, setTabId] = useState<number | null>(null);
  const [state, setState] = useState<GreenlightCaptureState | null>(null);
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (tabId === null) return;
    const key = greenlightCaptureKey(tabId);
    void action(async () => { setState((await chrome.storage.session.get(key))[key] as GreenlightCaptureState ?? null); });
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[key]) setState(changes[key].newValue as GreenlightCaptureState ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [tabId]);
  useEffect(() => () => controller.current?.abort(), []);
  const selected = () => { if (tabId === null) throw new Error('Find and select an open authorized Greenlight dashboard first.'); return tabId; };
  return <section className="card">
    <h3>Greenlight collection</h3>
    <p>Open your signed-in <code>portal.greenlight.ai/dashboard</code> tab. This collector reads rendered rates and captures native <code>app.greenlight.ai/ui/suppliers/.../time</code> JSON; it never extracts or replays bearer tokens.</p>
    <div className="toolbar"><button disabled={running} onClick={() => void action(async () => {
      if (!await chrome.permissions.request({ origins: [`${GREENLIGHT_PORTAL}/*`] })) throw new Error('Greenlight portal access was denied.');
      const found = await greenlightTabs(); setTabs(found);
      if (!found.length) throw new Error('No open Greenlight dashboard tab found. Open and sign in to the portal, then find it again.');
      setTabId(found[0]!.id ?? null); setNotice(`Found ${found.length} authorized-origin dashboard tab(s). Select the one you intend to collect.`);
    })}>Find Greenlight tab</button>
      <select aria-label="Greenlight dashboard tab" disabled={running} value={tabId ?? ''} onChange={event => setTabId(Number(event.target.value))}><option value="" disabled>Select dashboard</option>{tabs.map(tab => <option key={tab.id} value={tab.id}>Greenlight dashboard · tab {tab.id}</option>)}</select>
      <button disabled={running || tabId === null} onClick={() => void action(async () => {
        const snapshot = await collectGreenlightDom(selected()); setNotice(`Saved ${snapshot.rows.length} rendered deliverables and ${snapshot.rates.length} rates for ${snapshot.period}.`);
      })}>Collect rendered week & rates</button>
      <button disabled={running || tabId === null} onClick={() => void action(async () => { await armGreenlightCapture(selected(), true); setNotice('Capture armed. Reload Greenlight or navigate its weeks normally with DevTools open. Native responses save even if you close this dashboard.'); })}>Start financial capture</button>
      <button disabled={running || tabId === null} onClick={() => void action(() => armGreenlightCapture(selected(), false))}>Stop financial capture</button>
      <button disabled={running || tabId === null} onClick={() => void action(async () => {
        setRunning(true); controller.current = new AbortController();
        try { await collectPreviousGreenlightWeek(selected(), controller.current.signal); setNotice('Previous week captured and rendered data saved. No automatic loop or retry was used.'); }
        finally { controller.current = null; setRunning(false); }
      })}>Capture previous week</button>
      <button disabled={!running} onClick={() => controller.current?.abort()}>Cancel week collection</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    <p className="muted">Keep Greenlight and its DevTools open. Each previous-week click collects exactly one week, with a 60-second timeout and no retry. Navigating away cancels that pending action, but passive native capture remains armed until stopped. No hidden history loop. DOM alone cannot recover notes or task counts.</p>
    <dl className="progress-stats">{[
      ['Capture state', state?.enabled ? 'Armed' : 'Stopped'], ['Native responses saved', state?.received ?? 0],
      ['Latest HTTP status', state?.status ?? 'Not observed'], ['Last captured range', state?.start ? `${state.start} — ${state.end}` : 'Not captured'],
      ['Latest error', state?.error ?? 'None'],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {state?.error && <p role="alert" className="warning">{state.error}</p>}
    <label className="field">Import saved Greenlight time JSON<input type="file" accept=".json,application/json" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) void action(async () => {
        if (file.size > 20_000_000) throw new Error('Financial import exceeds 20 MB.');
        let payload: unknown;
        try { payload = JSON.parse(await file.text()); } catch { throw new Error('Financial import is not valid JSON. Import only the response body, never authentication headers.'); }
        const count = await ingestFinancialTime(payload); setNotice(`Saved ${count} deliverables from Greenlight JSON. Reimport updates by supplier and deliverable ID; it does not duplicate totals.`);
      });
    }} /></label>
  </section>;
}
export function FinancialBatchReconciliation() {
  const { payments, records } = useApp();
  const [notice, setNotice] = useState('');
  const reconciliation = useMemo(() => reconcileFinancialBatches(payments, records), [payments, records]);
  const observed = useMemo(() => observedBatchEarnings(payments, reconciliation), [payments, reconciliation]);
  const earnings = new Map(observed.rows.map(row => [row.key, row]));
  return <section className="card">
    <h3>Automatic cached batch matching</h3>
    <button onClick={() => void action(async () => { const count = await rebuildBatchJoins(); setNotice(`Rebuilt batch joins locally; ${count} cached records updated. No task requests were made.`); })}>Rebuild cached batch joins</button>
    {notice && <p role="status">{notice}</p>}
    <p>Matches pipeline names to Greenlight note batches, preserving the Set code and batch date. Only the observed extra numeric segment before Set is removed. Attempt and Review work are reconciled separately.</p>
    <div className="review-table-scroll"><table aria-label="Automatic financial batch matches"><thead><tr>
      <th>Batch</th><th>Match / cached scope</th><th>Cached attempts / reviews</th><th>Paid attempts / reviews</th><th>Pending attempts / reviews</th><th>Unaccounted attempts</th><th>Unaccounted reviews</th><th>Remaining attempts to pay</th><th>Observed paid rate / remaining USD (estimate)</th>
    </tr></thead><tbody>{reconciliation.rows.map(row => <tr key={row.key}>
      <td>{row.tag ?? 'No saved deliverable'} · {row.batch}</td><td>{row.status === 'matched' || row.status === 'no-payment' ? `${row.status === 'matched' ? 'Matched' : 'No payment in cache'} · project ${row.projectId ?? 'unknown'} · pipeline ${row.pipelineId ?? 'unknown'} · iterations ${row.iterationIds.join(', ')}` : row.status === 'ambiguous' ? 'Ambiguous: multiple annotation or payment scopes' : 'No cached batch match'}</td>
      <td>{row.cachedAttempts ?? '—'} / {row.cachedReviews ?? '—'}{row.unknownWorkType ? ` · ${row.unknownWorkType} unknown work types` : ''}</td>
      <td>{row.paidAttempts} / {row.paidReviews}</td><td>{row.pendingAttempts} / {row.pendingReviews}</td>
      <td>{row.unaccountedAttempts ?? 'Uncertain / unavailable'}</td><td>{row.unaccountedReviews ?? 'Uncertain / unavailable'}</td><td>{row.remainingToPayAttempts ?? 'Unresolved'}</td>
      <td>{(['attempts', 'reviews'] as const).map(type => {
        const estimate = earnings.get(row.key)![type];
        return <div key={type}>{type === 'attempts' ? 'Attempt' : 'Review'}: {estimate.rateCents === null ? 'No observed rate' :
          `~${usd(estimate.rateCents)} each (${usd(estimate.paidAmountCents)} / ${estimate.paidCount} paid)`} · remaining {estimate.remainingCents === null ? 'Unavailable' : `~${usd(estimate.remainingCents)}`}
          {estimate.reason && <span className="muted"> · {estimate.reason}</span>}</div>;
      })}</td>
    </tr>)}</tbody></table></div>
    {!reconciliation.rows.length && <p className="muted">Capture or import annotation batch metadata and Greenlight notes to reconcile saved work.</p>}
    <p className="muted">{reconciliation.missingMetadata} submitted records lack cached batch metadata. Surviving local names are recovered automatically; discarded names require an original JSON import or explicit re-collection. No tasks are refreshed by this view. Observed rates use only positive paid deliverables attributable to one batch and one work type, including positive task-count correction deltas. Mixed amounts are not allocated. Estimates use the unrounded paid-amount/count ratio and round the resulting total to cents. Missing payment periods or changed rates can overstate earnings; these are batch estimates, never individual paid labels or guaranteed payments.</p>
  </section>;
}
function FinancialMappings() {
  const { payments, records, financialDom, financialMappings } = useApp();
  const batches = useMemo(() => [...new Map(payments.flatMap(payment => payment.batches.map(batch => {
    const key = JSON.stringify([payment.organizationId, payment.engagementId, payment.tag, batchName(batch.name)]);
    return [key, { organizationId: payment.organizationId, engagementId: payment.engagementId, tag: payment.tag, batch: batch.name }] as const;
  }))).entries()], [payments]);
  const [batchKey, setBatchKey] = useState('');
  const [dimension, setDimension] = useState<'iteration' | 'project'>('iteration');
  const [scope, setScope] = useState('');
  const [rate, setRate] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const scopes = [...new Set(records.filter(record => record.source.url.startsWith('https://www.linkedin.com/')).map(record => dimension === 'iteration' ? record.iterationId : record.projectId).filter((value): value is string => !!value))].sort();
  const projections = financialProjection(payments, records, financialMappings);
  const latestRates = financialDom[0]?.rates ?? [];
  return <section className="card">
    <h3>Batch reconciliation & estimated unbilled earnings</h3>
    <p>Notes name batches, not individual annotation IDs. Map an entire LinkedIn iteration (recommended) or project to the matching Greenlight batch. This reconciles aggregate task counts; it does not mark arbitrary individual annotations paid.</p>
    <div className="filter-grid">
      <label className="field">Greenlight batch<select aria-label="Greenlight batch" value={batchKey} onChange={event => { setBatchKey(event.target.value); setConfirmed(false); }}><option value="">Select batch</option>{batches.map(([key, batch]) => <option key={key} value={key}>{batch.tag} · {batch.batch}</option>)}</select></label>
      <label className="field">Annotation grouping<select aria-label="Annotation grouping" value={dimension} onChange={event => { setDimension(event.target.value === 'iteration' ? 'iteration' : 'project'); setScope(''); setConfirmed(false); }}><option value="iteration">Iteration</option><option value="project">Project</option></select></label>
      <label className="field">Annotation scope<select aria-label="Annotation scope" value={scope} onChange={event => { setScope(event.target.value); setConfirmed(false); }}><option value="">Select scope</option>{scopes.map(id => <option key={id} value={id}>{dimension} {id} · {records.find(record => (dimension === 'iteration' ? record.iterationId : record.projectId) === id)?.title ?? 'Saved annotations'}</option>)}</select></label>
      <label className="field">USD rate per submitted annotation<input type="number" min="0.01" step="0.01" value={rate} onChange={event => { setRate(event.target.value); setConfirmed(false); }} /></label>
    </div>
    <p className="muted">Observed portal rates: {latestRates.length ? latestRates.map(entry => `${entry.name}: ${usd(entry.cents)}/${entry.unit}`).join(' · ') : 'Collect rendered dashboard rates first.'} A displayed $/project rate is not automatically a per-annotation rate. Select only a confirmed applicable rate; review work is counted separately and has no inferred rate.</p>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I confirm this complete annotation scope is the same batch, the rate applies per submitted annotation, and I have captured its relevant payment periods.</label>
    <button disabled={!confirmed || !batchKey || !scope || !rate} onClick={() => void action(async () => {
      const batch = batches.find(([key]) => key === batchKey)?.[1];
      if (!batch) throw new Error('Selected financial batch is no longer available.');
      await saveFinancialMapping({ ...batch, dimension, annotationScope: scope, rateCents: cents(rate) }); setConfirmed(false);
    })}>Save confirmed batch mapping</button>
    <p className="muted">Estimate = unique submitted annotations − paid Att counts − pending Att counts, multiplied by the confirmed rate. Captured ledger pending amounts are already owed and are not multiplied again. Estimates can overstate unpaid work if payment weeks are missing. Conflicting/negative counts are excluded, not clamped to zero.</p>
    <div className="review-table-scroll"><table aria-label="Financial batch reconciliation"><thead><tr><th>Batch / scope</th><th>Submitted</th><th>Paid tasks</th><th>Pending tasks</th><th>Unbilled tasks (estimate)</th><th>Unbilled USD (estimate)</th><th>Action</th></tr></thead><tbody>
      {projections.map(row => <tr key={row.mapping.key}><td>{row.mapping.batch} · {row.mapping.dimension} {row.mapping.annotationScope}</td><td>{row.submitted}</td><td>{row.paid}</td><td>{row.pending}</td><td>{row.remaining ?? 'Uncertain counts'}</td><td>{row.projectedCents === null ? 'Not estimated' : usd(row.projectedCents)}</td><td><button onClick={() => void action(() => db.financialMappings.delete(row.mapping.key))}>Remove mapping</button></td></tr>)}
    </tbody></table></div>
    {!projections.length && <p className="muted">No mapping: paid/pending ledger amounts and note counts are available, but unbilled annotation earnings are not estimated.</p>}
    {!!projections.length && <p>Estimated unbilled: {usd(exactSum(projections.map(row => row.projectedCents ?? 0)))} · {projections.filter(row => row.uncertain).length} mappings excluded as uncertain. Uses the entire saved financial and annotation cache, independently of the ledger filters below.</p>}
  </section>;
}
export function Financials() {
  const { payments, financialFilters: filters, setFinancialFilters, financialPeriods, financialDom } = useApp();
  const [exporting, setExporting] = useState(false);
  const filtered = useMemo(() => filterPayments(payments, filters), [payments, filters]);
  const stats = financialSummary(filtered);
  const tags = [...new Set(payments.map(payment => payment.tag))].sort();
  const organizations = [...new Set(payments.map(payment => payment.organizationId))].sort();
  const groups = [...new Map(filtered.map(payment => [JSON.stringify([payment.engagementId, payment.tag]), { engagementId: payment.engagementId, tag: payment.tag }])).values()];
  return <div className="review-page">
    <p className="notice">USD · status 4 = Processed / paid; every other status = pending, as configured for this account. Money comes from actual deliverables, not inferred task rates. No real account collection has been verified in development.</p>
    <FinancialCollection />
    <FinancialSummary />
    <FinancialBatchReconciliation />
    <FinancialMappings />
    <section className="card filters" aria-label="Financial filters"><div className="filter-top"><input aria-label="Search financials" placeholder="Search tag, batch or notes" value={filters.search} onChange={event => setFinancialFilters({ search: event.target.value })} /><button onClick={() => setFinancialFilters(emptyFinancialFilters)}>Clear financial filters</button><Badge>{filtered.length} / {payments.length} saved deliverables</Badge></div>
      <div className="filter-grid"><label className="field">Payment date from<input type="date" value={filters.from} onChange={event => setFinancialFilters({ from: event.target.value })} /></label><label className="field">Payment date through<input type="date" value={filters.to} onChange={event => setFinancialFilters({ to: event.target.value })} /></label>
        <label className="field">Payment state<select aria-label="Payment state" value={filters.status} onChange={event => setFinancialFilters({ status: event.target.value })}><option value="">All</option><option value="paid">Paid / Processed</option><option value="pending">Pending</option></select></label>
        <label className="field">Financial tag<select aria-label="Financial tag" value={filters.tag} onChange={event => setFinancialFilters({ tag: event.target.value })}><option value="">All</option>{tags.map(tag => <option key={tag}>{tag}</option>)}</select></label>
        <label className="field">Supplier scope<select aria-label="Supplier scope" value={filters.organization} onChange={event => setFinancialFilters({ organization: event.target.value })}><option value="">All</option>{organizations.map(org => <option key={org}>{org}</option>)}</select></label>
      </div></section>
    <div className="metrics"><Metric label="Filtered paid USD" value={financialPeriods.length ? usd(stats.paidCents) : 'Not captured'} note={`${stats.paidEntries} processed entries`} accent /><Metric label="Filtered pending USD" value={financialPeriods.length ? usd(stats.pendingCents) : 'Not captured'} note={`${stats.pendingEntries} pending entries`} /><Metric label="Paid tasks from notes" value={String(stats.paidAnnotations)} note={`${stats.paidReviews} reviews counted separately`} /><Metric label="Pending tasks from notes" value={String(stats.pendingAnnotations)} note={`${stats.pendingReviews} reviews counted separately`} /></div>
    <p className="muted">{stats.unknownCounts} filtered deliverables with unknown task counts. Money is counted once per supplier/deliverable ID; matching notes or payroll IDs do not identify duplicate payments. Corrections use Actual − Paid counts. Amounts are not allocated among multi-batch notes without explicit evidence.</p>
    <section className="card"><h3>Payments by engagement / project tag</h3><div className="review-table-scroll"><table aria-label="Financial project totals"><thead><tr><th>Tag / engagement</th><th>Paid USD</th><th>Pending USD</th><th>Paid / pending annotations</th></tr></thead><tbody>{groups.map(group => {
      const summary = financialSummary(filtered.filter(payment => payment.engagementId === group.engagementId && payment.tag === group.tag));
      return <tr key={JSON.stringify(group)}><td>{group.tag}<br /><small>{group.engagementId}</small></td><td>{usd(summary.paidCents)}</td><td>{usd(summary.pendingCents)}</td><td>{summary.paidAnnotations} / {summary.pendingAnnotations}{summary.unknownCounts ? ' · incomplete counts' : ''}</td></tr>;
    })}</tbody></table></div></section>
    <section className="card"><div className="section-heading"><h3>Saved payment ledger</h3><button onClick={() => setExporting(true)}><Download size={14} />Export financials</button></div>
      <div className="review-table-scroll"><table aria-label="Financial payment ledger"><thead><tr><th>Date</th><th>Tag / engagement</th><th>Amount USD</th><th>Payment status</th><th>Annotations / reviews</th><th>Batch notes</th></tr></thead><tbody>{filtered.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 500).map(payment => <tr key={payment.key}><td>{payment.date}</td><td>{payment.tag}<br /><small>{payment.engagementId}</small></td><td>{usd(payment.amountCents)}</td><td>{payment.status === 4 ? 'Processed / paid' : `Pending (${payment.status})`}</td><td>{payment.countWarning ? 'Unknown' : `${payment.batches.reduce((sum, batch) => sum + batch.annotations, 0)} / ${payment.batches.reduce((sum, batch) => sum + batch.reviews, 0)}`}</td><td><details><summary>{payment.batches.length} batch entries{payment.countWarning ? ' · inspect warning' : ''}</summary><p>{payment.notes}</p>{payment.countWarning && <p className="warning">{payment.countWarning}</p>}</details></td></tr>)}</tbody></table></div>
      {filtered.length > 500 && <p className="muted">Showing latest 500 matching deliverables; metrics and exports include all matches.</p>}
      {!payments.length && <Empty title="No captured payment ledger">Start financial capture with Greenlight DevTools open and reload or navigate weeks, or import a saved time response. Rendered week observations are separate and do not invent task counts.</Empty>}
    </section>
    <section className="card"><h3>Captured scope & rendered rates</h3><p>Ledger periods are not a guarantee of complete payment history. Captures update existing IDs but do not delete previously captured payments omitted by a later response; use explicit financial cache deletion for removed records.</p>
      {financialPeriods.map(period => <p key={period.key}>{period.start.slice(0, 10)} — {period.end.slice(0, 10)} · {period.received} deliverables · saved {period.capturedAt}</p>)}
      {financialDom.slice(0, 10).map(snapshot => <details key={snapshot.key}><summary>{snapshot.period} · {snapshot.rows.length} rendered entries · saved {snapshot.capturedAt}</summary><p>{snapshot.rates.map(rate => `${rate.name}: ${usd(rate.cents)}/${rate.unit}`).join(' · ') || 'No rendered engagement rate found.'}</p></details>)}
      <button className="danger" onClick={() => { if (window.confirm('Delete financial ledger, rendered observations and batch mappings? Annotation records and snapshots remain. Stop Greenlight capture first.')) void action(clearFinancialData); }}>Clear financial cache</button>
    </section>
    {exporting && <FinancialExport onClose={() => setExporting(false)} />}
  </div>;
}
