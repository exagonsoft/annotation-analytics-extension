import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownUp, Copy, ExternalLink } from 'lucide-react';
import type { AnnotationRecord } from '../core/model';
import { defaultSettings } from '../core/model';
import { hasScore } from '../core/analytics';
import { download, exportRecords } from '../core/export';
import { safeUrl } from '../core/privacy';
import { Badge, Empty, Modal } from './components';
import { action, useApp } from './store';
import { saveSettings } from '../core/storage';
import { annotationBatchMetadata, hasCachedDetail } from '../core/review';
import { reviewScore, reviewState, submittedDate } from '../core/review-analytics';
import { annotationPaymentCoverage, type AnnotationPaymentCoverage } from '../core/finance';
import { batchJoinKey } from '../core/batches';

export function annotationCell(record: AnnotationRecord, column: string, coverage?: AnnotationPaymentCoverage): string {
  if (column === 'batchPayment') return coverage?.label ?? 'Batch payment unresolved';
  if (column === 'batchRemaining') return coverage?.remaining == null ? 'Unresolved' : String(coverage.remaining);
  const cached = hasCachedDetail(record), data = cached ? record.detail!.data : null;
  if (column === 'reviewScore') return cached ? String(reviewScore(record) ?? 'No numeric review score') : 'Not collected';
  if (column === 'reviewStatus') return data?.review.status ?? (cached ? 'No review status' : 'Not collected');
  if (column === 'batch') return annotationBatchMetadata(record).pipelineName ?? 'Not captured';
  if (column === 'pipelineId') return annotationBatchMetadata(record).pipelineId ?? 'Not captured';
  if (column === 'workType') return annotationBatchMetadata(record).workType ?? 'Not captured';
  if (column === 'submittedAt') return cached ? submittedDate(record) ?? 'Not captured' : 'Not collected';
  if (column === 'detailStatus') return record.detail?.data && !cached ? 'Unverified detail' : reviewState(record);
  if (column === 'durationSeconds') return data?.durationInSeconds == null ? 'Not captured' : String(data.durationInSeconds);
  if (column === 'idleSeconds') return data?.idleDurationInSeconds == null ? 'Not captured' : String(data.idleDurationInSeconds);
  if (['overall', 'aesthetics', 'functionality'].includes(column)) {
    const s = record.scores[column as 'overall' | 'aesthetics' | 'functionality'];
    return s.scoringStatus === 'verified' ? String(s.value) : s.scoringStatus === 'invalid' ? 'Invalid mapping/value' : s.scoreSource ? 'No task answer' : 'Not mapped';
  }
  if (column === 'availability') return hasScore(record) ? 'Scored' : 'Unscored';
  if (column === 'source') return record.source.method;
  const value = record[column as keyof AnnotationRecord];
  return typeof value === 'string' ? value : '—';
}
const columns: Record<string, string> = {
  id: 'Annotation ID', title: 'Title', projectId: 'Project', iterationId: 'Iteration', state: 'Status', type: 'Type',
  createdAt: 'Created at', lastModifiedAt: 'Last modified', aesthetics: 'Aesthetics', functionality: 'Functionality', overall: 'Overall', availability: 'Score availability', source: 'Source',
  taskId: 'Task ID', pipelineId: 'Pipeline ID', batch: 'Batch', workType: 'Work type', reviewScore: 'Reviewer score',
  reviewStatus: 'Review status', submittedAt: 'Submitted at', claimedAt: 'Claimed at', detailStatus: 'Detail collection',
  templateId: 'Template', durationSeconds: 'Duration (seconds)', idleSeconds: 'Idle (seconds)',
  batchPayment: 'Batch payment coverage', batchRemaining: 'Batch remaining to pay',
};
const taskAnswerColumns = ['aesthetics', 'functionality', 'overall', 'availability'];
const cachedColumns = [...defaultSettings.columns.filter(column => !taskAnswerColumns.includes(column)),
  'taskId', 'reviewScore', 'reviewStatus', 'batch', 'workType', 'submittedAt', 'detailStatus', 'batchPayment', 'batchRemaining'];
export function Detail({ record, onClose }: { record: AnnotationRecord; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [section, setSection] = useState('rawPayload');
  const content = section === 'metadata' ? { ...record, rawPayload: undefined, inputData: undefined, annotationData: undefined, latestTaskResult: undefined } : record[section as keyof AnnotationRecord];
  const lines = JSON.stringify(content, null, 2).split('\n');
  const matching = search ? lines.map((line, index) => ({ line, index })).filter(v => v.line.toLowerCase().includes(search.toLowerCase())) : [];
  return <Modal title={`Annotation ${record.id}`} onClose={onClose} description="Redacted, read-only record. Score paths refer to the parsed raw payload.">
    <div className="detail-meta"><h3>{record.title ?? 'Untitled annotation'}</h3><Badge>{record.state ?? 'Unknown state'}</Badge>
      {record.taskUrl && <a href={safeUrl(record.taskUrl)} target="_blank" rel="noreferrer">Task <ExternalLink size={14} /></a>}
      {record.attemptUrl && <a href={safeUrl(record.attemptUrl)} target="_blank" rel="noreferrer">Attempt <ExternalLink size={14} /></a>}
      <button onClick={() => void action(() => navigator.clipboard.writeText(record.id))}><Copy size={14} />Copy ID</button>
    </div>
    <div className="score-grid">{Object.entries(record.scores).map(([name, s]) => <div className="card" key={name}><b>{name}</b><p>{s.value ?? 'Unknown'} <Badge good={s.scoringStatus === 'verified'}>{s.scoringStatus}</Badge></p><small>{s.scoreSource ?? 'No field mapping'}<br />{s.scale} · {s.level} level</small></div>)}</div>
    {record.detail && <section className="card"><h3>Reviewer quality (separate from task answers)</h3><p>Score: {record.detail.data?.review.annotationScore ?? 'Unknown'} · Status: {record.detail.data?.review.status ?? 'Unknown'} · Collection: {record.detail.status}</p><pre className="json-view feedback-text">{record.detail.data?.review.feedback ?? 'No reviewer feedback available.'}</pre></section>}
    {record.warnings.map(warning => <p className="warning" key={warning}>{warning}</p>)}
    <div className="toolbar"><select aria-label="Inspector section" value={section} onChange={e => setSection(e.target.value)}>
      {['rawPayload', 'metadata', 'inputData', 'annotationData', 'latestTaskResult', 'iteration', 'pipeline', 'source', 'scores', 'detail', 'warnings'].map(s => <option key={s}>{s}</option>)}
    </select><input aria-label="Search raw JSON" placeholder="Search JSON..." value={search} onChange={e => setSearch(e.target.value)} />
      <button onClick={() => void action(() => navigator.clipboard.writeText(JSON.stringify(content, null, 2)))}><Copy size={14} />Copy redacted section</button></div>
    {search && <p className="muted">{matching.length} matching lines</p>}
    <pre className="json-view">{search ? matching.map(v => `${v.index + 1}: ${v.line}`).join('\n') : lines.join('\n')}</pre>
  </Modal>;
}
export function Annotations({ records }: { records: AnnotationRecord[] }) {
  const { settings, records: savedRecords, payments, filters, setFilters } = useApp();
  const dataset = savedRecords.length ? savedRecords : records;
  const coverage = useMemo(() => annotationPaymentCoverage(dataset, payments), [dataset, payments]);
  const batches = useMemo(() => [...new Map(dataset.flatMap(record => {
    const name = annotationBatchMetadata(record).pipelineName;
    return name ? [[record.batchKey ?? batchJoinKey(name), name] as const] : [];
  })).entries()].sort((a, b) => a[1].localeCompare(b[1])), [dataset]);
  const cachedOnly = dataset.some(hasCachedDetail) && !dataset.some(hasScore);
  const legacyColumns = settings.columns.length === defaultSettings.columns.length && settings.columns.every((column, index) => column === defaultSettings.columns[index]);
  const [sort, setSort] = useState({ column: 'createdAt', asc: false });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<AnnotationRecord | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => [...records].sort((a, b) => {
    const left = annotationCell(a, sort.column, coverage.get(a.key)), right = annotationCell(b, sort.column, coverage.get(b.key));
    const dimension = ['aesthetics', 'functionality', 'overall'].find(d => d === sort.column) as 'aesthetics' | 'functionality' | 'overall' | undefined;
    const aScore = dimension ? a.scores[dimension].value : sort.column === 'reviewScore' && hasCachedDetail(a) ? reviewScore(a) : null;
    const bScore = dimension ? b.scores[dimension].value : sort.column === 'reviewScore' && hasCachedDetail(b) ? reviewScore(b) : null;
    const compare = typeof aScore === 'number' && typeof bScore === 'number' ? aScore - bScore : left.localeCompare(right, undefined, { numeric: true });
    return sort.asc ? compare : -compare;
  }), [records, sort, coverage]);
  const last = Math.max(0, Math.ceil(sorted.length / pageSize) - 1);
  const currentPage = Math.min(page, last);
  const current = sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const virtual = useVirtualizer({ count: current.length, getScrollElement: () => scroller.current, estimateSize: () => 48, overscan: 8 });
  const visible = (cachedOnly && legacyColumns && settings.annotationColumnsMode !== 'custom' ? cachedColumns : settings.columns).filter(c => c in columns);
  const saveColumns = (selectedColumns: string[]) => action(async () => {
    const next = { ...settings, columns: selectedColumns, annotationColumnsMode: 'custom' as const };
    await saveSettings(next); useApp.getState().setSettings(next);
  });
  function toggle(key: string) { setSelected(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  return <section className="card annotations"><div className="section-heading"><div><h3>Annotation explorer</h3><p className="muted">{records.length.toLocaleString()} matching · {selected.size} selected</p></div>
    <div className="toolbar"><button onClick={() => void saveColumns(cachedColumns)}>Cached detail columns</button><button onClick={() => void saveColumns(defaultSettings.columns)}>Task-answer columns</button><details className="column-picker"><summary>Columns</summary><div>{Object.entries(columns).map(([key, label]) => <label key={key}><input type="checkbox" checked={visible.includes(key)} onChange={() => void saveColumns(visible.includes(key) ? visible.filter(c => c !== key) : [...visible, key])} />{label}</label>)}</div></details>
      <button disabled={!records.some(r => selected.has(r.key))} onClick={() => download(exportRecords(records.filter(r => selected.has(r.key)), 'csv', coverage), 'selected-annotations.csv', 'text/csv')}>Export selected</button></div>
    </div>
    <div className="filter-grid">
      <label className="field">Batch join<select aria-label="Annotation batch join" value={filters.batchKey ?? ''} onChange={event => { setPage(0); setFilters({ batchKey: event.target.value }); }}><option value="">All cached batches</option>{batches.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label className="field">Batch payment coverage<select aria-label="Annotation batch payment coverage" value={filters.paymentState ?? ''} onChange={event => { setPage(0); setFilters({ paymentState: event.target.value }); }}><option value="">All</option><option value="paid">Paid batch coverage</option><option value="remaining">Remaining to be paid (pending + partial)</option><option value="pending">Pending batch</option><option value="partial">Partially paid batch</option><option value="unresolved">Unresolved batch payment</option><option value="not-submitted">Not submitted</option></select></label>
    </div>
    <p className="muted">Payment columns join normalized batch names to saved Greenlight notes. Remaining to pay = cached submitted work − paid note counts, including work already in pending deliverables. A partially paid batch does not identify which individual IDs were paid; missing payment periods can overstate the remainder.</p>
    {cachedOnly && <p className="notice">Cached reviewer details are available, but no mapped Aesthetics, Functionality or Overall task answers are stored. Reviewer score, review status, batch and work type come from their own cached fields, never from substituted task-answer scores. Column presets do not fetch data.</p>}
    {!records.length ? <Empty title="No matching annotations" /> : <>
      <div className="table-scroll" ref={scroller} role="table" aria-label="Annotations" aria-rowcount={records.length + 1}>
        <div className="table-header table-row" role="row" style={{ minWidth: 48 + visible.length * 170 }}><div role="columnheader"><input aria-label="Select page" type="checkbox" checked={current.length > 0 && current.every(r => selected.has(r.key))} onChange={e => setSelected(prev => { const next = new Set(prev); current.forEach(r => { if (e.target.checked) next.add(r.key); else next.delete(r.key); }); return next; })} /></div>
          {visible.map(column => <button role="columnheader" key={column} onClick={() => setSort(prev => ({ column, asc: prev.column === column ? !prev.asc : true }))}>{columns[column]}<ArrowDownUp size={12} /></button>)}
        </div>
        <div style={{ height: virtual.getTotalSize(), position: 'relative', minWidth: 48 + visible.length * 170 }} role="rowgroup">
          {virtual.getVirtualItems().map(item => { const record = current[item.index]!; return <div key={record.key} className="table-row data-row" role="row" aria-rowindex={currentPage * pageSize + item.index + 2} style={{ position: 'absolute', top: 0, transform: `translateY(${item.start}px)`, height: item.size }}>
            <div role="cell"><input aria-label={`Select ${record.id}`} type="checkbox" checked={selected.has(record.key)} onChange={() => toggle(record.key)} /></div>
            {visible.map(column => <button role="cell" key={column} className={column === 'id' ? 'id-cell' : ''} title={annotationCell(record, column, coverage.get(record.key))} onClick={() => setDetail(record)}>{annotationCell(record, column, coverage.get(record.key))}</button>)}
          </div>; })}
        </div>
      </div>
      <div className="pagination"><label>Rows per page <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)); }}><option>50</option><option>100</option><option>500</option><option>1000</option></select></label><span>Page {currentPage + 1} of {last + 1}</span><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><button disabled={currentPage >= last} onClick={() => setPage(currentPage + 1)}>Next</button></div>
    </>}
    {detail && <Detail record={detail} onClose={() => setDetail(null)} />}
  </section>;
}
