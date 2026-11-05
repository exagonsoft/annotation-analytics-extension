import { useState } from 'react';
import type { Dimension, Mapping, Settings as SettingsType } from '../core/model';
import { defaultSettings } from '../core/model';
import { fieldPaths, score } from '../core/parsing';
import { clearCurrent, db, remap, saveSettings } from '../core/storage';
import { action, useApp } from './store';
import { Badge } from './components';
import { Detail } from './Annotations';
import { clearFinancialData } from '../core/finance-storage';

function MappingEditor({ dimension, onSave }: { dimension: Dimension; onSave: (mapping?: Mapping) => Promise<void> }) {
  const settings = useApp(s => s.settings);
  const records = useApp(s => s.records);
  const existing = settings.mappings[dimension];
  const [path, setPath] = useState(existing?.path ?? '');
  const [kind, setKind] = useState<'numeric' | 'categorical'>(existing?.kind ?? 'numeric');
  const [min, setMin] = useState(String(existing?.min ?? ''));
  const [max, setMax] = useState(String(existing?.max ?? ''));
  const [scale, setScale] = useState(existing?.scale ?? '');
  const [scalePath, setScalePath] = useState(existing?.scalePath ?? '');
  const [minPath, setMinPath] = useState(existing?.minPath ?? '');
  const [maxPath, setMaxPath] = useState(existing?.maxPath ?? '');
  const [categories, setCategories] = useState(existing?.categories?.join('\n') ?? '');
  const [level, setLevel] = useState<'annotation' | 'task'>(existing?.level ?? 'annotation');
  const [entityPath, setEntityPath] = useState(existing?.entityPath ?? '');
  const [inspecting, setInspecting] = useState(false);
  const mapping: Mapping = { path: path.trim(), kind, level, entityPath: entityPath.trim() || undefined, ...(kind === 'numeric' ? {
    min: Number(min), max: Number(max), scale: scale.trim(), scalePath: scalePath.trim() || undefined, minPath: minPath.trim() || undefined, maxPath: maxPath.trim() || undefined,
  } : { categories: categories.split('\n').map(s => s.trim()).filter(Boolean) }) };
  const sample = records.slice(0, 100);
  const preview = sample.map(record => score(record.rawPayload, mapping));
  const numericConfig = (scalePath.trim() || scale.trim()) &&
    (minPath.trim() || min !== '' && Number.isFinite(Number(min))) &&
    (maxPath.trim() || max !== '' && Number.isFinite(Number(max))) &&
    (minPath.trim() || maxPath.trim() || Number(min) < Number(max));
  const canSave = path.trim() && (level === 'annotation' || entityPath.trim()) && (kind === 'categorical' || numericConfig);
  const paths = [...new Set(sample.slice(0, 5).flatMap(r => fieldPaths(r.rawPayload)))].sort();
  return <section className="card"><div className="section-heading"><h3>{dimension[0]!.toUpperCase() + dimension.slice(1)} mapping</h3><Badge good={!!existing}>{existing ? 'Configured' : 'Unknown'}</Badge></div>
    <label className="field">Verified JSON path (dot notation)<input list={`${dimension}-paths`} placeholder="annotationData.evaluation.overall" value={path} onChange={e => setPath(e.target.value)} /></label>
    <datalist id={`${dimension}-paths`}>{paths.map(p => <option key={p}>{p}</option>)}</datalist>
    <div className="filter-grid"><label className="field">Result type<select value={kind} onChange={e => setKind(e.target.value === 'numeric' ? 'numeric' : 'categorical')}><option value="numeric">Numeric</option><option value="categorical">Categorical preference</option></select></label><label className="field">Score record level<select value={level} onChange={e => setLevel(e.target.value === 'task' ? 'task' : 'annotation')}><option value="annotation">Annotation</option><option value="task">Task</option></select></label></div>
    {level === 'task' && <label className="field">Verified task identity path<input list={`${dimension}-paths`} placeholder="taskId or relatedResult.taskId" value={entityPath} onChange={e => setEntityPath(e.target.value)} /><small>Repeated task-level results are counted once per task, origin and project.</small></label>}
    {kind === 'numeric' ? <><div className="filter-grid"><label className="field">Scale name<input placeholder="Verified rubric name" value={scale} onChange={e => setScale(e.target.value)} /></label><label className="field">Minimum<input type="number" value={min} onChange={e => setMin(e.target.value)} /></label><label className="field">Maximum<input type="number" value={max} onChange={e => setMax(e.target.value)} /></label></div>
      <details><summary>Per-record scale metadata (mixed rubrics)</summary><p className="muted">Optional verified JSON paths override the static scale or bounds above. Missing/invalid metadata makes that score invalid; scales are never mixed.</p><div className="filter-grid">
        <label className="field">Scale-name JSON path<input list={`${dimension}-paths`} value={scalePath} onChange={e => setScalePath(e.target.value)} /></label>
        <label className="field">Minimum JSON path<input list={`${dimension}-paths`} value={minPath} onChange={e => setMinPath(e.target.value)} /></label>
        <label className="field">Maximum JSON path<input list={`${dimension}-paths`} value={maxPath} onChange={e => setMaxPath(e.target.value)} /></label>
      </div></details></> :
      <label className="field">Allowed categories (one per line; leave empty to use observed strings)<textarea rows={4} value={categories} onChange={e => setCategories(e.target.value)} /></label>}
    <p className="muted">Preview of first {sample.length} loaded records: {preview.filter(s => s.scoringStatus === 'verified').length} verified, {preview.filter(s => s.scoringStatus === 'invalid').length} invalid, {preview.filter(s => s.scoringStatus === 'missing').length} missing.</p>
    <div className="toolbar"><button className="primary" disabled={!canSave} onClick={() => void action(() => onSave(mapping))}>Apply to all records</button><button onClick={() => void action(async () => { await onSave(undefined); setPath(''); })}>Remove mapping</button><button disabled={!records.length} onClick={() => setInspecting(true)}>Inspect real JSON</button></div>
    {inspecting && records[0] && <Detail record={records[0]} onClose={() => setInspecting(false)} />}
  </section>;
}
export function Settings() {
  const [notice, setNotice] = useState('');
  const save = async (value: SettingsType) => { await saveSettings(value); await remap(value.mappings); setNotice('Mappings saved and all loaded records recalculated.'); };
  return <div className="source-layout">
    <section className="card wide"><h3>Verified scores, not assumptions</h3><p>Select real fields from captured JSON. Numeric scores require an explicit scale and bounds. Numeric strings are not coerced. Categorical values remain categorical. State, title, and task-result status are never inferred as scores.</p><p className="muted">Task-level and annotation-level numeric results are kept in separate averaging groups. Scores are not mixed across scales, and no implicit scale conversion is performed.</p></section>
    {(['aesthetics', 'functionality', 'overall'] as const).map(dimension => <MappingEditor key={dimension} dimension={dimension} onSave={async mapping => {
      const mappings = { ...useApp.getState().settings.mappings };
      if (mapping) mappings[dimension] = mapping; else delete mappings[dimension];
      await save({ ...useApp.getState().settings, mappings });
    }} />)}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="card"><h3>Privacy & local data</h3><p>No telemetry, cloud services, credential storage, or remote code. Raw payloads are conservatively redacted, but free text can still contain sensitive information. Review exports before sharing them.</p><div className="toolbar">
      <button onClick={() => void action(async () => {
        const permissions = await chrome.permissions.getAll();
        if (permissions.origins?.length) await chrome.permissions.remove({ origins: permissions.origins });
        setNotice('Optional API host permissions revoked.');
      })}>Revoke API host permissions</button>
      <button className="danger" onClick={() => { if (window.confirm('Delete ALL local annotations, financial records/mappings, sources, snapshots, presets and settings? Stop active collectors first. This cannot be undone.')) void action(async () => {
        await clearCurrent(); await clearFinancialData(); await db.snapshots.clear(); await chrome.storage.local.clear(); await chrome.storage.session.clear();
        await saveSettings(defaultSettings); setNotice('Local data and settings deleted. Optional host permissions can be revoked separately.');
      }); }}>Delete all local data</button>
    </div></section>
  </div>;
}
