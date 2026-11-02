import type { AnnotationRecord, Dimension, Filters } from './model';
import { pathValue } from './parsing';

export function groupName(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(pathValue(value, 'name') ?? pathValue(value, 'id') ?? 'Unknown');
}
export function hasScore(record: AnnotationRecord): boolean {
  return Object.values(record.scores).some(s => s.scoringStatus === 'verified');
}
export function filterRecords(records: AnnotationRecord[], filters: Filters): AnnotationRecord[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return records.filter(r => {
    if (query && !`${r.id} ${r.title ?? ''}`.toLocaleLowerCase().includes(query)) return false;
    if (filters.from && (!r.createdAt || r.createdAt < `${filters.from}T00:00:00.000Z`)) return false;
    if (filters.to && (!r.createdAt || r.createdAt > `${filters.to}T23:59:59.999Z`)) return false;
    if (filters.project && r.projectId !== filters.project) return false;
    if (filters.iteration && r.iterationId !== filters.iteration) return false;
    if (filters.template && r.templateId !== filters.template) return false;
    if (filters.pipeline && groupName(r.pipeline) !== filters.pipeline) return false;
    if (filters.state && r.state !== filters.state) return false;
    if (filters.resultState && pathValue(r.latestTaskResult, 'state') !== filters.resultState) return false;
    if (filters.type && r.type !== filters.type) return false;
    if (filters.source && r.source.method !== filters.source) return false;
    if (filters.scored === 'yes' && !hasScore(r) || filters.scored === 'no' && hasScore(r)) return false;
    const s = r.scores.overall;
    if (filters.category && (s.scoringStatus !== 'verified' || s.value !== filters.category)) return false;
    if (filters.scale && s.scale !== filters.scale) return false;
    if (filters.min && (typeof s.value !== 'number' || s.value < Number(filters.min))) return false;
    if (filters.max && (typeof s.value !== 'number' || s.value > Number(filters.max))) return false;
    return true;
  });
}
export function distribution(records: AnnotationRecord[], key: (r: AnnotationRecord) => string) {
  const groups = new Map<string, number>();
  for (const record of records) {
    const name = key(record);
    groups.set(name, (groups.get(name) ?? 0) + 1);
  }
  return [...groups].map(([name, count]) => ({ name, count, percentage: records.length ? count / records.length * 100 : 0 })).sort((a, b) => b.count - a.count);
}
export function scoreSummary(records: AnnotationRecord[], dimension: Dimension) {
  const taskGroups = new Map<string, AnnotationRecord[]>();
  const valid = records.filter(r => {
    const s = r.scores[dimension];
    if (s.scoringStatus !== 'verified') return false;
    if (s.level === 'task' && s.entityId) {
      const key = JSON.stringify([r.source.url ? new URL(r.source.url).origin : 'import', r.projectId, s.entityId]);
      const group = taskGroups.get(key);
      if (group) group.push(r); else taskGroups.set(key, [r]);
      return false;
    }
    return true;
  });
  let conflictingTasks = 0;
  for (const group of taskGroups.values()) {
    const signatures = new Set(group.map(r => JSON.stringify([r.scores[dimension].value, r.scores[dimension].scale])));
    if (signatures.size > 1) conflictingTasks++;
    else valid.push(group[0]!);
  }
  const numeric = new Map<string, { sum: number; count: number }>();
  for (const record of valid) {
    const score = record.scores[dimension];
    if (typeof score.value === 'number' && score.scale) {
      const key = `${score.scale} (${score.level})`;
      const group = numeric.get(key) ?? { sum: 0, count: 0 };
      group.sum += score.value;
      group.count++;
      numeric.set(key, group);
    }
  }
  const categorical = valid.filter(r => typeof r.scores[dimension].value === 'string');
  return {
    scored: valid.length,
    conflictingTasks,
    numeric: [...numeric].map(([scale, group]) => ({ scale, count: group.count, mean: group.sum / group.count })),
    categories: distribution(categorical, r => String(r.scores[dimension].value)),
    values: distribution(valid, r => `${r.scores[dimension].value} ${r.scores[dimension].scale ?? ''} (${r.scores[dimension].level})`),
  };
}
export function summarize(records: AnnotationRecord[]) {
  const submitted = records.filter(r => r.state === 'SUBMITTED').length;
  const pending = records.filter(r => ['PENDING', 'NOT_STARTED', 'IN_PROGRESS', 'CLAIMED', 'QUEUED', 'STARTED'].includes(r.state ?? '')).length;
  return {
    total: records.length, submitted, pending, scored: records.filter(hasScore).length,
    completionRate: records.length ? submitted / records.length * 100 : null,
    overall: scoreSummary(records, 'overall'), aesthetics: scoreSummary(records, 'aesthetics'), functionality: scoreSummary(records, 'functionality'),
  };
}
export function timeline(records: AnnotationRecord[]) {
  const groups = new Map<string, AnnotationRecord[]>();
  for (const r of records) {
    if (!r.createdAt) continue;
    const date = r.createdAt.slice(0, 10);
    const group = groups.get(date);
    if (group) group.push(r); else groups.set(date, [r]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({
    date, volume: items.length, submitted: items.filter(r => r.state === 'SUBMITTED').length,
    averages: scoreSummary(items, 'overall').numeric,
  }));
}
