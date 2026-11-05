import { z } from 'zod';
import { redact } from './privacy';

export function batchJoinKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/\s+-\s*|\s*-\s+/g, ' - ')
    .replace(/\s+-\s+\d+(?=\s+-\s+Set\s+[A-Z]+\s+-\s+\d{4}-\d{2}-\d{2}$)/i, '').toLowerCase();
}
const identity = z.union([z.string().trim().min(1).max(200), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).transform(String);
const descriptorSchema = z.object({
  id: identity, name: z.string().trim().min(1).max(2000),
  lastModifiedAt: z.number().finite().nonnegative().nullish(),
  stages: z.array(z.object({ iterationId: identity, type: z.string().trim().min(1).max(100) })).max(100).optional(),
});
export interface BatchDescriptor {
  key: string;
  projectId: string;
  pipelineId: string;
  name: string;
  batchKey: string;
  stages: { iterationId: string; type: string }[];
  modifiedAt: number | null;
  conflict?: boolean;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function extractBatchCatalog(payload: unknown): { batches: BatchDescriptor[]; warnings: string[] } {
  const raw = object(payload), project = object(raw.project);
  const projectId = identity.safeParse(raw.projectId ?? project.id);
  if (!projectId.success) return { batches: [], warnings: [] };
  if (project.id != null && String(project.id) !== projectId.data) return { batches: [], warnings: ['Pipeline catalog project identity conflicts with the annotation.'] };
  const values: unknown[] = [];
  if (Array.isArray(project.pipelines)) {
    if (project.pipelines.length > 10_000) return { batches: [], warnings: ['Pipeline catalog exceeds 10,000 entries; excluded.'] };
    values.push(...project.pipelines);
  }
  if (raw.pipeline) values.push(raw.pipeline);
  const batches = new Map<string, BatchDescriptor>(), warnings: string[] = [];
  for (const value of values) {
    const parsed = descriptorSchema.safeParse(value);
    if (!parsed.success) {
      if (object(value).name != null) warnings.push('Unsupported pipeline metadata excluded from the batch catalog.');
      continue;
    }
    const name = String(redact(parsed.data.name));
    if (name.startsWith('[')) { warnings.push('Redacted pipeline name cannot establish a batch join.'); continue; }
    const key = JSON.stringify([projectId.data, parsed.data.id]);
    const descriptor: BatchDescriptor = { key, projectId: projectId.data, pipelineId: parsed.data.id, name, batchKey: batchJoinKey(name),
      stages: (parsed.data.stages ?? []).map(stage => ({ iterationId: stage.iterationId, type: stage.type.toUpperCase() })),
      modifiedAt: parsed.data.lastModifiedAt ?? null };
    const previous = batches.get(key);
    if (previous && previous.batchKey !== descriptor.batchKey) {
      batches.set(key, { ...previous, conflict: true }); warnings.push('Conflicting names for the same pipeline identity; batch recovery excluded.');
    } else batches.set(key, { ...descriptor, stages: descriptor.stages.length ? descriptor.stages : previous?.stages ?? [], conflict: previous?.conflict });
  }
  return { batches: [...batches.values()], warnings: [...new Set(warnings)] };
}
export function findBatchDescriptor(catalog: BatchDescriptor[], projectId: string | null, pipelineId: string | null, iterationId: string | null): BatchDescriptor | null {
  if (!projectId) return null;
  const candidates = catalog.filter(batch => !batch.conflict && batch.projectId === projectId &&
    (pipelineId ? batch.pipelineId === pipelineId : !!iterationId && batch.stages.some(stage => stage.iterationId === iterationId)));
  return candidates.length === 1 ? candidates[0]! : null;
}
export function mergeBatchDescriptors(values: BatchDescriptor[]): BatchDescriptor[] {
  const merged = new Map<string, BatchDescriptor>();
  for (const value of values) {
    const previous = merged.get(value.key);
    if (!previous) { merged.set(value.key, value); continue; }
    if (previous.modifiedAt !== null && (value.modifiedAt === null || previous.modifiedAt > value.modifiedAt)) continue;
    if (previous.batchKey !== value.batchKey) {
      merged.set(value.key, value.modifiedAt !== null && (previous.modifiedAt === null || value.modifiedAt > previous.modifiedAt) ?
        value : { ...previous, conflict: true });
      continue;
    }
    const stages = [...new Map([...previous.stages, ...value.stages].map(stage => [JSON.stringify(stage), stage])).values()];
    const newer = value.modifiedAt !== null && (previous.modifiedAt === null || value.modifiedAt > previous.modifiedAt);
    merged.set(value.key, { ...value, stages, conflict: value.conflict || !newer && previous.conflict });
  }
  return [...merged.values()];
}
