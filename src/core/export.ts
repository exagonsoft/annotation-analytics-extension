import type { AnnotationRecord } from './model';
import { redact } from './privacy';

export const csvColumns = ['annotation_id', 'title', 'project_id', 'iteration_id', 'template_id', 'status', 'type', 'created_at', 'last_modified_at', 'aesthetics', 'aesthetics_scale', 'aesthetics_status', 'aesthetics_path', 'aesthetics_level', 'functionality', 'functionality_scale', 'functionality_status', 'functionality_path', 'functionality_level', 'overall', 'overall_scale', 'overall_status', 'overall_path', 'overall_level', 'collection_method', 'source_url'];
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function exportRecords(records: AnnotationRecord[], format: 'csv' | 'json' | 'jsonl'): string {
  if (format === 'json') return JSON.stringify(redact(records), null, 2);
  if (format === 'jsonl') return records.map(r => JSON.stringify(redact(r))).join('\n');
  const rows = records.map(r => [
    r.id, r.title, r.projectId, r.iterationId, r.templateId, r.state, r.type, r.createdAt, r.lastModifiedAt,
    ...(['aesthetics', 'functionality', 'overall'] as const).flatMap(d => [r.scores[d].value, r.scores[d].scale, r.scores[d].scoringStatus, r.scores[d].scoreSource, r.scores[d].level]),
    r.source.method, r.source.url,
  ].map(csvCell).join(','));
  return '\uFEFF' + [csvColumns.join(','), ...rows].join('\r\n');
}
export function exportStructured(value: unknown, format: 'csv' | 'json' | 'jsonl'): string {
  const safe = redact(value);
  if (format === 'json') return JSON.stringify(safe, null, 2);
  if (format === 'jsonl') return JSON.stringify(safe);
  const rows: [string, unknown][] = [];
  function flatten(item: unknown, path: string) {
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) flatten(child, path ? `${path}.${key}` : key);
    } else rows.push([path, item]);
  }
  flatten(safe, '');
  return '\uFEFF' + ['field_path,value', ...rows.map(([path, item]) => `${csvCell(path)},${csvCell(item)}`)].join('\r\n');
}
export function download(content: string, filename: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
