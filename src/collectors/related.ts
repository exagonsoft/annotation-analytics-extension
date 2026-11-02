import type { AnnotationRecord, Mappings, Source } from '../core/model';
import { db } from '../core/storage';
import { normalize, object, pathValue } from '../core/parsing';
import { redact } from '../core/privacy';

export interface ResultJoin {
  arrayPath: string;
  resultIdPath: string;
  annotationIdPath: string;
}
export async function joinRelated(items: unknown[], source: Source, mappings: Mappings, join: ResultJoin): Promise<void> {
  const origin = new URL(source.url).origin;
  await db.transaction('rw', db.records, db.sources, async () => {
    const records = (await db.records.toArray()).filter(record => record.source.url && new URL(record.source.url).origin === origin);
    const index = new Map<string, AnnotationRecord[]>();
    for (const record of records) {
      const id = pathValue(record.rawPayload, join.annotationIdPath);
      if (typeof id !== 'string' && typeof id !== 'number') continue;
      const key = String(id);
      const matches = index.get(key);
      if (matches) matches.push(record); else index.set(key, [record]);
    }
    let matched = 0, unmatched = 0, ambiguous = 0;
    for (const item of items) {
      if (!object(item)) { unmatched++; continue; }
      const id = pathValue(item, join.resultIdPath);
      const matches = typeof id === 'string' || typeof id === 'number' ? index.get(String(id)) ?? [] : [];
      if (!matches.length) { unmatched++; continue; }
      if (matches.length > 1 && join.annotationIdPath === 'id') { ambiguous++; continue; }
      for (const record of matches) {
        const payload = object(record.rawPayload);
        const updated = normalize({ ...payload, relatedResult: redact(item) }, record.source, mappings);
        if (updated) { await db.records.put(updated); matched++; }
      }
    }
    source.received += items.length;
    source.pages++;
    source.diagnostics.push(`Related results: ${matched} annotation updates, ${unmatched} unmatched, ${ambiguous} ambiguous IDs skipped. Map fields under relatedResult.`);
    await db.sources.put(source);
  });
}
