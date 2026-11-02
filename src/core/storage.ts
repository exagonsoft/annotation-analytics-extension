import Dexie, { type Table } from 'dexie';
import type { AnnotationRecord, Mappings, Settings, Snapshot, Source } from './model';
import { defaultSettings } from './model';
import { normalize } from './parsing';
import { endpointUrl, redact, safeUrl } from './privacy';
import { hasCachedDetail, importedDetail, LINKEDIN_ORIGIN, mergeReviewRecord, repairDetailCache, reviewCollectorConfigSchema, type ReviewCollectorConfig, type ReviewRun } from './review';

function migrateRecord(record: AnnotationRecord): AnnotationRecord {
  const normalized = normalize(record.rawPayload, record.source);
  record.taskId ??= normalized?.taskId ?? null;
  record.detail ??= normalized?.detail ?? null;
  record.rawPayload = normalized?.detail?.data ? normalized.rawPayload : redact(record.rawPayload);
  for (const field of ['inputData', 'annotationData', 'latestTaskResult', 'pipeline', 'iteration'] as const) record[field] = redact(record[field]);
  for (const field of ['createdAt', 'claimedAt', 'lastModifiedAt'] as const) record[field] ??= normalized?.[field] ?? null;
  for (const dimension of ['aesthetics', 'functionality', 'overall'] as const) {
    const score = record.scores[dimension];
    if (score.scoreSource?.split('.').includes('currentVersionReview')) record.scores[dimension] = { ...score, value: null, scale: null, scoringStatus: 'invalid' };
  }
  const origin = safeUrl(record.source.url);
  if (origin && new URL(origin).origin === LINKEDIN_ORIGIN) record.key = JSON.stringify([LINKEDIN_ORIGIN, null, record.id]);
  return record.detail ? mergeReviewRecord(record, record.detail) : record;
}

export class AnalyticsDB extends Dexie {
  records!: Table<AnnotationRecord, string>;
  sources!: Table<Source, string>;
  snapshots!: Table<Snapshot, string>;
  reviewRuns!: Table<ReviewRun, string>;
  constructor(name = 'annotation-analytics') {
    super(name);
    this.version(1).stores({
      records: '&key, id, projectId, state, createdAt, source.id',
      sources: '&id, collectedAt, method',
      snapshots: '&id, createdAt',
    });
    this.version(2).stores({
      records: '&key, id, taskId, projectId, state, createdAt, source.id, detail.status',
      reviewRuns: '&id, startedAt, status',
    }).upgrade(async transaction => {
      const table = transaction.table<AnnotationRecord, string>('records');
      const records = await table.toArray();
      const merged = new Map<string, AnnotationRecord>();
      for (const original of records) {
        const record = migrateRecord(original);
        const previous = merged.get(record.key);
        if (!previous || (record.lastModifiedAt ?? '') >= (previous.lastModifiedAt ?? '')) merged.set(record.key, { ...record, detail: record.detail ?? previous?.detail ?? null });
        else if (!previous.detail && record.detail) merged.set(record.key, { ...previous, detail: record.detail });
      }
      await table.clear();
      await table.bulkPut([...merged.values()]);
      await transaction.table<Snapshot, string>('snapshots').toCollection().modify(snapshot => {
        snapshot.records = snapshot.records.map(migrateRecord);
      });
    });
    this.version(3).stores({}).upgrade(async transaction => {
      await transaction.table<AnnotationRecord, string>('records').toCollection().modify(record => {
        record.detail = repairDetailCache(record).detail;
      });
      await transaction.table<Snapshot, string>('snapshots').toCollection().modify(snapshot => {
        snapshot.records = snapshot.records.map(repairDetailCache);
      });
      await transaction.table<ReviewRun, string>('reviewRuns').where('status').equals('running')
        .modify({ status: 'interrupted', message: 'Previous page closed. Resume explicitly; request diagnostics start with the next collection.' });
    });
  }
}
export const db = new AnalyticsDB();
export function newSource(method: Source['method'], url = ''): Source {
  return {
    id: crypto.randomUUID(), method, url: safeUrl(url), collectedAt: new Date().toISOString(),
    reportedTotal: null, completeness: 'partial', pages: 0, received: 0, uniqueRecords: 0, requests: 0, duplicates: 0, errors: 0, diagnostics: [],
  };
}
export async function ingest(rawRecords: unknown[], source: Source, mappings: Mappings): Promise<number> {
  const records = rawRecords.map(raw => normalize(raw, source, mappings)).filter((r): r is AnnotationRecord => !!r);
  return db.transaction('rw', db.records, db.sources, async () => {
    const existing = await db.records.bulkGet(records.map(r => r.key));
    const sameIds = records.length ? await db.records.where('id').anyOf([...new Set(records.map(r => r.id))]).toArray() : [];
    const peersById = new Map<string, AnnotationRecord[]>();
    for (const peer of sameIds) {
      if (!peer.source.url) continue;
      const key = JSON.stringify([new URL(peer.source.url).origin, peer.id]);
      const peers = peersById.get(key);
      if (peers) peers.push(peer); else peersById.set(key, [peer]);
    }
    const batch = new Map<string, AnnotationRecord>();
    let duplicates = 0;
    for (const [index, record] of records.entries()) {
      const peers = record.source.url ? peersById.get(JSON.stringify([new URL(record.source.url).origin, record.id])) ?? [] : [];
      if (record.source.method === 'dom' && peers.some(r => r.source.method !== 'dom' && (!record.projectId || !r.projectId || record.projectId === r.projectId))) { duplicates++; continue; }
      let replacedDom = false;
      if (record.source.method !== 'dom') {
        for (const peer of peers) if (peer.source.method === 'dom' && !peer.projectId && peer.key !== record.key) { await db.records.delete(peer.key); replacedDom = true; }
      }
      if (existing[index] || batch.has(record.key) || replacedDom) duplicates++;
      const previous = batch.get(record.key) ?? existing[index];
      if (previous && record.detail?.data) {
        batch.set(record.key, mergeReviewRecord(previous, { ...record.detail, completedRunId: previous.detail?.attemptRunId ?? previous.detail?.completedRunId,
          attempts: previous.detail?.attempts ?? 0, errors: previous.detail?.errors ?? [] }));
        continue;
      }
      // DOM summaries must never replace a richer network response.
      if (record.source.method === 'dom' && previous && previous.source.method !== 'dom') continue;
      if (previous?.lastModifiedAt && record.lastModifiedAt && previous.lastModifiedAt > record.lastModifiedAt) continue;
      batch.set(record.key, { ...record, detail: previous?.detail ?? record.detail, taskId: record.taskId ?? previous?.taskId ?? null });
    }
    source.received += records.length;
    source.duplicates += duplicates;
    source.uniqueRecords = Math.max(0, source.received - source.duplicates);
    source.pages++;
    await db.records.bulkPut([...batch.values()]);
    await db.sources.put(source);
    return records.length - duplicates;
  });
}
export async function getSettings(): Promise<Settings> {
  if (!globalThis.chrome?.storage?.local) return { ...defaultSettings };
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings as Partial<Settings> | undefined;
  return { ...defaultSettings, ...settings, reviewCollector: { ...defaultSettings.reviewCollector, ...settings?.reviewCollector } };
}
export async function saveSettings(settings: Settings): Promise<void> {
  if (settings.endpoint) endpointUrl(settings.endpoint);
  if (!globalThis.chrome?.storage?.local) throw new Error('Settings require an installed Chrome extension.');
  await chrome.storage.local.set({ settings });
}
export async function saveReviewConfig(config: ReviewCollectorConfig): Promise<void> {
  reviewCollectorConfigSchema.parse(config);
  if (!globalThis.chrome?.storage?.local) throw new Error('Review settings require an installed Chrome extension.');
  await chrome.storage.local.set({ settings: { ...await getSettings(), reviewCollector: config } });
}
export async function remap(mappings: Mappings): Promise<void> {
  await db.transaction('rw', db.records, async () => {
    const records = await db.records.toArray();
    await db.records.bulkPut(records.map(record => {
      const normalized = normalize(record.rawPayload, record.source, mappings);
      return normalized ? { ...normalized, detail: record.detail ?? normalized.detail, taskId: record.taskId ?? normalized.taskId } : null;
    }).filter((record): record is AnnotationRecord => !!record));
  });
}
export async function saveSnapshot(name: string, mappings: Mappings): Promise<void> {
  await db.transaction('rw', db.records, db.sources, db.snapshots, async () => {
    await db.snapshots.add({
      id: crypto.randomUUID(), name: name.trim() || 'Untitled snapshot', createdAt: new Date().toISOString(), schemaVersion: 2,
      records: await db.records.toArray(), sources: await db.sources.toArray(), mappings,
    });
  });
}
export async function restoreSnapshot(snapshot: Snapshot, replace: boolean, mappings: Mappings): Promise<void> {
  if (![1, 2].includes(snapshot.schemaVersion)) throw new Error('Unsupported snapshot schema.');
  const records = snapshot.records.map(r => {
    const record = normalize(redact(r.rawPayload), r.source, mappings);
    return record ? mergeReviewRecord({ ...record, taskId: r.taskId ?? record.taskId }, importedDetail(r.detail, r.id) ?? record.detail ?? { status: 'pending', data: null, attempts: 0, errors: [], fetchedAt: null, lastAttemptAt: null, via: 'import' }) : null;
  }).filter((r): r is AnnotationRecord => !!r);
  await db.transaction('rw', db.records, db.sources, async () => {
    if (replace) { await db.records.clear(); await db.sources.clear(); }
    const existing = replace ? [] : await db.records.bulkGet(records.map(record => record.key));
    await db.records.bulkPut(records.map((record, index) => {
      const previous = existing[index];
      return previous?.detail && hasCachedDetail(previous) && !hasCachedDetail(record) ? mergeReviewRecord(record, previous.detail) : record;
    }));
    await db.sources.bulkPut(snapshot.sources);
  });
}
export async function clearCurrent(): Promise<void> {
  await db.transaction('rw', db.records, db.sources, db.reviewRuns, async () => { await db.records.clear(); await db.sources.clear(); await db.reviewRuns.clear(); });
}
