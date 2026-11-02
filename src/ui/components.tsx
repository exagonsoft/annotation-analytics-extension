import * as Dialog from '@radix-ui/react-dialog';
import { X, Search, SlidersHorizontal, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AnnotationRecord, Filters } from '../core/model';
import { emptyFilters } from '../core/model';
import { groupName } from '../core/analytics';
import { pathValue } from '../core/parsing';
import { saveSettings } from '../core/storage';
import { useApp, action } from './store';

export function Modal({ title, children, onClose, description = 'Read-only annotation data and collection controls.' }: { title: string; children: ReactNode; onClose: () => void; description?: string }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="overlay" /><Dialog.Content className="modal">
      <div className="section-heading"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description className="muted">{description}</Dialog.Description></div>
        <Dialog.Close className="icon-button" aria-label="Close dialog"><X size={20} /></Dialog.Close></div>
      {children}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
export function Metric({ label, value, note, accent = false }: { label: string; value: ReactNode; note?: string; accent?: boolean }) {
  return <article className={`metric ${accent ? 'accent' : ''}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>;
}
export function Badge({ children, good = false }: { children: ReactNode; good?: boolean }) {
  return <span className={`badge ${good ? 'good' : ''}`}>{children}</span>;
}
export function Empty({ title = 'No annotations yet', children }: { title?: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><SlidersHorizontal /></div><h3>{title}</h3><p>{children ?? 'Start DevTools capture, connect an authorized API, or import a saved JSON response in Sources.'}</p></div>;
}
export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return <label className="field">{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value)}><option value="">All</option>{options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>;
}
function values(records: AnnotationRecord[], key: (r: AnnotationRecord) => unknown): string[] {
  return [...new Set(records.map(key).filter(v => typeof v === 'string' && v).map(String))].sort();
}
export function FilterBar() {
  const { records, filters, setFilters, settings } = useApp();
  const change = (key: keyof Filters, value: string) => setFilters({ [key]: value });
  const fields: { key: keyof Filters; label: string; values: string[] }[] = [
    { key: 'project', label: 'Project', values: values(records, r => r.projectId) },
    { key: 'iteration', label: 'Iteration', values: values(records, r => r.iterationId) },
    { key: 'pipeline', label: 'Pipeline', values: values(records, r => groupName(r.pipeline)) },
    { key: 'template', label: 'Template', values: values(records, r => r.templateId) },
    { key: 'state', label: 'Status', values: values(records, r => r.state) },
    { key: 'resultState', label: 'Task result status', values: values(records, r => pathValue(r.latestTaskResult, 'state')) },
    { key: 'type', label: 'Type', values: values(records, r => r.type) },
    { key: 'source', label: 'Source', values: values(records, r => r.source.method) },
    { key: 'category', label: 'Overall preference', values: values(records, r => typeof r.scores.overall.value === 'string' ? r.scores.overall.value : '') },
    { key: 'scale', label: 'Overall numeric scale', values: values(records, r => r.scores.overall.scale) },
  ];
  return <section className="filters card" aria-label="Global filters">
    <div className="filter-top"><label className="search"><Search size={16} /><input aria-label="Search annotations" placeholder="Search annotation ID or title..." value={filters.search} onChange={e => change('search', e.target.value)} /></label>
      <button onClick={() => setFilters(emptyFilters)}><RotateCcw size={14} />Clear all</button>
      <button onClick={() => { const name = window.prompt('Filter preset name'); if (name?.trim()) void action(async () => { await saveSettings({ ...settings, presets: [...settings.presets, { name, filters }] }); }); }}>Save preset</button>
      <select aria-label="Load filter preset" value="" onChange={e => { const preset = settings.presets[Number(e.target.value)]; if (preset) setFilters(preset.filters); }}><option value="">Saved presets</option>{settings.presets.map((p, i) => <option key={i} value={i}>{p.name}</option>)}</select>
    </div>
    <details><summary><SlidersHorizontal size={14} />Advanced filters <Badge>{Object.values(filters).filter(Boolean).length} active</Badge></summary>
      <div className="filter-grid">
        <label className="field">From (UTC)<input type="date" value={filters.from} onChange={e => change('from', e.target.value)} /></label>
        <label className="field">Through (UTC)<input type="date" value={filters.to} onChange={e => change('to', e.target.value)} /></label>
        {fields.map(f => <Select key={f.key} label={f.label} value={filters[f.key]} onChange={v => change(f.key, v)} options={f.values} />)}
        <label className="field">Task-answer score availability<select value={filters.scored} onChange={e => change('scored', e.target.value)}><option value="">All</option><option value="yes">Scored</option><option value="no">Unscored</option></select></label>
        <label className="field">Overall minimum<input type="number" value={filters.min} onChange={e => change('min', e.target.value)} /></label>
        <label className="field">Overall maximum<input type="number" value={filters.max} onChange={e => change('max', e.target.value)} /></label>
      </div>
      {(filters.min || filters.max) && !filters.scale && <p className="warning">Select an Overall scale to compare values on one verified scale.</p>}
    </details>
  </section>;
}
