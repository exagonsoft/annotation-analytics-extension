import { useState } from 'react';
import { Download, GitCompare, Save, Trash2 } from 'lucide-react';
import { summarize } from '../core/analytics';
import { download } from '../core/export';
import { db, restoreSnapshot, saveSnapshot } from '../core/storage';
import { action, useApp } from './store';
import { Badge, Empty, Modal } from './components';
import type { Snapshot } from '../core/model';

export function History() {
  const { snapshots, settings, records } = useApp();
  const [name, setName] = useState('');
  const [compare, setCompare] = useState<Snapshot | null>(null);
  return <>
    <section className="card toolbar"><input aria-label="Snapshot name" placeholder="Snapshot name..." value={name} onChange={e => setName(e.target.value)} /><button className="primary" onClick={() => void action(async () => { await saveSnapshot(name, settings.mappings); setName(''); })}><Save size={16} />Save snapshot</button><span className="muted">Immutable local copies, including records, mappings and source completeness.</span></section>
    {!snapshots.length ? <Empty title="No saved snapshots">Save a snapshot to compare collections or restore a previous dataset.</Empty> : <div className="source-layout">{snapshots.map(snapshot => <article className="card" key={snapshot.id}>
      <div className="section-heading"><h3>{snapshot.name}</h3><Badge>Schema {snapshot.schemaVersion}</Badge></div><p>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.records.length.toLocaleString()} annotations · {summarize(snapshot.records).scored} scored</p>
      <div className="toolbar"><button onClick={() => { if (window.confirm('Replace current records with this snapshot? Current score mappings will be applied.')) void action(() => restoreSnapshot(snapshot, true, settings.mappings)); }}>Replace current</button>
        <button onClick={() => void action(() => restoreSnapshot(snapshot, false, settings.mappings))}>Merge</button><button onClick={() => setCompare(snapshot)}><GitCompare size={14} />Compare</button>
        <button onClick={() => download(JSON.stringify(snapshot, null, 2), `snapshot-${snapshot.id}.json`)}><Download size={14} />Export</button>
        <button aria-label={`Delete ${snapshot.name}`} onClick={() => { if (window.confirm(`Delete snapshot "${snapshot.name}"?`)) void action(() => db.snapshots.delete(snapshot.id)); }}><Trash2 size={14} /></button>
      </div>
    </article>)}</div>}
    {compare && <Modal title={`Compare with ${compare.name}`} onClose={() => setCompare(null)} description="Comparison by stable annotation identity, not task title.">
      {(() => {
        const old = new Map(compare.records.map(r => [r.key, r]));
        const now = new Map(records.map(r => [r.key, r]));
        const added = records.filter(r => !old.has(r.key));
        const removed = compare.records.filter(r => !now.has(r.key));
        const changed = records.filter(r => old.has(r.key) && JSON.stringify(r.rawPayload) !== JSON.stringify(old.get(r.key)?.rawPayload));
        return <><div className="progress-stats"><div><small>Added since snapshot</small><b>{added.length}</b></div><div><small>Absent from current</small><b>{removed.length}</b></div><div><small>Changed raw payload</small><b>{changed.length}</b></div></div><p className="muted">Current: {records.length} total / {summarize(records).scored} scored. Snapshot: {compare.records.length} total / {summarize(compare.records).scored} scored. Mapping changes can alter scores without changing raw data.</p><pre className="json-view">{JSON.stringify({ added: added.map(r => r.id), removed: removed.map(r => r.id), changed: changed.map(r => r.id) }, null, 2)}</pre></>;
      })()}
    </Modal>}
  </>;
}
