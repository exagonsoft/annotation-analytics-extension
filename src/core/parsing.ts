import { z } from 'zod';
import type { AnnotationRecord, Json, Mapping, Mappings, Score, Source } from './model';
import { redact, safeUrl } from './privacy';
import { detailCollection, detailPayload, isDetailPayload, LINKEDIN_ORIGIN, parseAnnotationDetail, type DetailCollection } from './review';
import { batchJoinKey } from './batches';

export const objectSchema = z.record(z.string(), z.unknown());
export function object(value: unknown): Record<string, unknown> | null {
  const result = objectSchema.safeParse(value);
  return result.success ? result.data : null;
}
export function pathValue(value: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (parts.length > 25 || parts.some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) return undefined;
  let current = value;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function text(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}
function date(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? new Date(value).toISOString() : null;
  const str = text(value);
  return str && Number.isFinite(Date.parse(str)) ? new Date(str).toISOString() : null;
}
function decoded(value: unknown, name: string, warnings: string[]): Json {
  if (typeof value === 'string' && /^[{[]/.test(value.trim())) {
    try { return redact(JSON.parse(value)); } catch { warnings.push(`${name}: malformed serialized JSON`); }
  }
  return redact(value);
}
export function score(value: unknown, mapping?: Mapping): Score {
  const entity = mapping?.entityPath ? pathValue(value, mapping.entityPath) : null;
  const entityId = typeof entity === 'string' || typeof entity === 'number' ? String(entity) : null;
  const base: Score = { value: null, scale: null, scoreSource: mapping?.path ?? null, scoringStatus: 'missing', level: mapping?.level ?? 'annotation', entityId };
  if (!mapping) return base;
  if (mapping.path.split('.').includes('currentVersionReview')) return { ...base, scoringStatus: 'invalid' };
  const found = pathValue(value, mapping.path);
  if (found === null || found === undefined || found === '') return base;
  if (mapping.level === 'task' && !entityId) return { ...base, scoringStatus: 'invalid' };
  if (mapping.kind === 'numeric') {
    const min = mapping.minPath ? pathValue(value, mapping.minPath) : mapping.min;
    const max = mapping.maxPath ? pathValue(value, mapping.maxPath) : mapping.max;
    const scale = mapping.scalePath ? pathValue(value, mapping.scalePath) : mapping.scale;
    if (typeof found !== 'number' || !Number.isFinite(found) ||
      typeof min !== 'number' || typeof max !== 'number' || min >= max ||
      !Number.isFinite(min) || !Number.isFinite(max) ||
      found < min || found > max || typeof scale !== 'string' || !scale.trim()) {
      return { ...base, scoringStatus: 'invalid' };
    }
    return { ...base, value: found, scale: `${scale.trim()}:${min}:${max}`, scoringStatus: 'verified' };
  }
  if (typeof found !== 'string' || (mapping.categories?.length && !mapping.categories.includes(found))) {
    return { ...base, scoringStatus: 'invalid' };
  }
  return { ...base, value: found, scoringStatus: 'verified' };
}
export function normalize(raw: unknown, source: Source, mappings: Mappings = {}): AnnotationRecord | null {
  const obj = object(redact(raw));
  if (!obj || !text(obj.id)) return null;
  const warnings: string[] = [];
  if (Object.values(mappings).some(mapping => mapping?.path.split('.').includes('currentVersionReview'))) warnings.push('Reviewer quality fields belong to Review Analytics, not task-answer scores.');
  const inputData = decoded(obj.inputData, 'inputData', warnings);
  const annotationData = decoded(obj.annotationData, 'annotationData', warnings);
  const latestTaskResult = decoded(obj.latestTaskResult, 'latestTaskResult', warnings);
  const projectId = text(obj.projectId);
  const id = String(obj.id);
  const scope = safeUrl(source.url);
  const origin = scope ? new URL(scope).origin : 'import';
  let detail: DetailCollection | null = null;
  if (isDetailPayload(obj, scope)) {
    try { detail = detailCollection(parseAnnotationDetail(obj, id), source.method === 'devtools' ? 'devtools' : 'import'); }
    catch (error) { warnings.push(error instanceof Error ? error.message : 'Invalid review detail.'); }
  }
  const payload = redact(detail?.data ? { ...detailPayload(detail.data), inputData, annotationData, latestTaskResult } : { ...obj, inputData, annotationData, latestTaskResult });
  return {
    key: JSON.stringify([origin, origin === LINKEDIN_ORIGIN ? null : projectId, id]), id, projectId, taskId: text(obj.taskId),
    iterationId: text(obj.iterationId), templateId: text(obj.templateId), type: text(obj.type),
    state: text(obj.state), createdAt: date(obj.createdAt), claimedAt: date(obj.claimedAt), lastModifiedAt: date(obj.lastModifiedAt),
    title: text(pathValue(inputData, 'title')) ?? text(obj.title),
    taskUrl: safeUrl(text(obj.taskUrl) ?? '') || null,
    attemptUrl: safeUrl(text(pathValue(annotationData, 'ATTEMPT_URL')) ?? '') || null,
    inputData, annotationData, latestTaskResult, pipeline: detail?.data ? redact(detailPayload(detail.data).pipeline) : redact(obj.pipeline), iteration: detail?.data ? detail.data.iterationId === null ? null : { id: detail.data.iterationId } : redact(obj.iteration),
    batchKey: detail?.data?.pipelineName ? batchJoinKey(detail.data.pipelineName) : typeof pathValue(obj.pipeline, 'name') === 'string' ? batchJoinKey(String(pathValue(obj.pipeline, 'name'))) : null,
    scores: { aesthetics: score(payload, mappings.aesthetics), functionality: score(payload, mappings.functionality), overall: score(payload, mappings.overall) },
    source: { ...source, url: scope }, rawPayload: payload, warnings, detail,
  };
}
export function isAnnotation(value: unknown): boolean {
  const obj = object(value);
  return !!obj && !!text(obj.id) && (
    obj.type === 'ANNOTATION' || 'annotationData' in obj ||
    ('taskId' in obj && 'state' in obj) ||
    ('state' in obj && ('inputData' in obj || 'iterationId' in obj || 'latestTaskResult' in obj))
  );
}
export interface Envelope {
  records: unknown[];
  arrayPath: string;
  total: number | null;
}
export function discover(payload: unknown): Envelope {
  const candidates: { items: unknown[]; path: string }[] = [];
  function visit(value: unknown, path: string, depth: number) {
    if (depth > 5) return;
    if (Array.isArray(value)) {
      const items = value.map(item => isAnnotation(item) ? item : object(item)?.node);
      if (items.some(isAnnotation) || value.length === 0) candidates.push({ items, path });
      return;
    }
    const obj = object(value);
    if (obj) for (const [key, child] of Object.entries(obj)) visit(child, path ? `${path}.${key}` : key, depth + 1);
  }
  if (isAnnotation(payload)) candidates.push({ items: [payload], path: '' });
  else visit(payload, '', 0);
  const best = candidates.sort((a, b) => b.items.filter(isAnnotation).length - a.items.filter(isAnnotation).length)[0];
  const root = object(payload);
  const container = best?.path.includes('.') ? object(pathValue(payload, best.path.split('.').slice(0, -1).join('.'))) : root;
  const totalValues = [container?.total, container?.totalCount, pathValue(container, 'pagination.total'), pathValue(root, 'meta.total'), root?.total, root?.totalCount];
  const total = totalValues.find(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
  return { records: best?.items.filter(isAnnotation) ?? [], arrayPath: best?.path ?? '', total: typeof total === 'number' ? total : null };
}
export function parseImport(textContent: string): unknown[] {
  if (textContent.length > 50_000_000) throw new Error('Import exceeds the 50 MB limit. Split it into smaller files.');
  try { return [JSON.parse(textContent)]; } catch {
    return textContent.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      try { return JSON.parse(line) as unknown; } catch { throw new Error(`Invalid JSONL on line ${index + 1}.`); }
    });
  }
}
export function fieldPaths(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > 10) return [];
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];
  return Object.entries(value).slice(0, 200).flatMap(([key, child]) => fieldPaths(child, prefix ? `${prefix}.${key}` : key, depth + 1)).slice(0, 2000);
}
