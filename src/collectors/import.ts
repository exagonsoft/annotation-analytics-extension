import { discover, object, parseImport } from '../core/parsing';
import type { Mappings } from '../core/model';
import { db, ingest, newSource } from '../core/storage';
import { safeUrl } from '../core/privacy';
import { detailPayload, importedDetail } from '../core/review';

export async function importData(text: string, mappings: Mappings, sourceUrl = ''): Promise<number> {
  const documents = parseImport(text);
  const groups = new Map<string, unknown[]>();
  const append = (url: string, value: unknown) => {
    const records = groups.get(url);
    if (records) records.push(value); else groups.set(url, [value]);
  };
  const add = (value: unknown) => {
    const obj = object(value);
    if (obj && obj.rawPayload && object(obj.source)) {
      const url = safeUrl(String(object(obj.source)?.url ?? ''));
      const saved = obj.detail ? importedDetail(obj.detail, String(obj.id)) : null;
      append(url, saved?.data ? { ...object(obj.rawPayload), ...detailPayload(saved.data) } : obj.rawPayload);
    } else {
      const url = safeUrl(sourceUrl);
      append(url, value);
    }
  };
  for (const payload of documents) {
    const obj = object(payload);
    if (obj?.schemaVersion && Array.isArray(obj.records)) obj.records.forEach(add);
    else if (Array.isArray(payload) && payload.some(r => object(r)?.rawPayload)) payload.forEach(add);
    else if (obj?.rawPayload) add(obj);
    else discover(payload).records.forEach(add);
  }
  if (![...groups.values()].some(records => records.length)) throw new Error('No supported annotation records found in this import.');
  let count = 0;
  for (const [url, records] of groups) {
    const source = newSource('import', url);
    source.diagnostics = ['Imported data; completeness cannot be verified from a saved response alone.'];
    count += await ingest(records, source, mappings);
    await db.sources.put(source);
  }
  return count;
}
