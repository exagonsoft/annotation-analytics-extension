import { describe, expect, it } from 'vitest';
import { discover, fieldPaths, normalize, parseImport, pathValue, score } from '../src/core/parsing';
import { endpointUrl, redact } from '../src/core/privacy';
import { emptyFilters } from '../src/core/model';
import { distribution, filterRecords, scoreSummary, summarize } from '../src/core/analytics';
import { csvCell, exportRecords, exportStructured } from '../src/core/export';
import { newSource } from '../src/core/storage';
import { fixture, mappings } from './fixtures';

const source = newSource('import', 'https://platform.example/api/tasks?token=secret');
const record = (id = '1', overrides = {}) => normalize(fixture(id, overrides), source, mappings)!;
describe('parsing and explicit scores', () => {
  it('decodes nested fields without inventing scores', () => {
    const r = normalize(fixture(), source)!;
    expect(pathValue(r.inputData, 'title')).toContain('Overall Website Preference');
    expect(pathValue(r.annotationData, 'ATTEMPT_URL')).toBe('https://platform.example/attempt/1');
    expect(r.scores.overall.scoringStatus).toBe('missing');
    expect(r.source.url).not.toContain('secret');
    expect(r.latestTaskResult).toMatchObject({ state: 'NOT_STARTED' });
  });
  it('handles missing properties, missing IDs and malformed JSON', () => {
    expect(normalize({}, source)).toBeNull();
    expect(normalize({ id: 1 }, source)?.title).toBeNull();
    expect(record('1', { inputData: '{"title":bad}' }).warnings).toHaveLength(1);
    expect(record('1', { createdAt: 'invalid' }).createdAt).toBeNull();
    expect(() => parseImport('{broken\n{also broken')).toThrow('line 1');
    expect(parseImport('{"id":1}\n{"id":2}')).toHaveLength(2);
  });
  it('detects supported root and nested envelopes and totals', () => {
    expect(discover({ data: { tasks: [fixture(), { id: 'unrelated' }], total: 7 } })).toMatchObject({ arrayPath: 'data.tasks', total: 7, records: [fixture()] });
    expect(discover(fixture()).records).toHaveLength(1);
    expect(discover({ unrelated: [{ id: 1 }] }).records).toHaveLength(0);
    expect(discover({ tasks: [], total: 0 }).total).toBe(0);
    expect(discover({ data: { tasks: { edges: [{ node: fixture() }], totalCount: 9 } } })).toMatchObject({ total: 9, records: [fixture()] });
  });
  it('maps actual paths and distinguishes invalid from absent', () => {
    expect(record().scores.overall.value).toBe(4);
    expect(record('2', { annotationData: '{}' }).scores.overall.scoringStatus).toBe('missing');
    expect(record('2', { annotationData: '{"evaluation":{"overall":"4"}}' }).scores.overall.scoringStatus).toBe('invalid');
    expect(record('2', { annotationData: '{"evaluation":{"overall":9}}' }).scores.overall.scoringStatus).toBe('invalid');
    expect(score({}, mappings.overall).value).toBeNull();
    expect(pathValue({}, '__proto__.x')).toBeUndefined();
    expect(fieldPaths(record().rawPayload)).toContain('annotationData.evaluation.overall');
  });
  it('does not conflate distinct attempts with the same title', () => {
    expect(record('1').key).not.toBe(record('2').key);
    expect(record('1', { projectId: 'other' }).key).not.toBe(record('1').key);
  });
});
describe('analytics and filters', () => {
  const records = [record('1'), record('2', { annotationData: null, state: 'IN_PROGRESS' }), record('3', { annotationData: '{"evaluation":{"overall":2,"aesthetics":"Website B better"}}' })];
  it('counts statuses and excludes missing scores from the denominator', () => {
    expect(summarize(records)).toMatchObject({ total: 3, submitted: 2, pending: 1, scored: 2 });
    expect(scoreSummary(records, 'overall').numeric[0]).toMatchObject({ mean: 3, count: 2 });
    expect(scoreSummary(records, 'aesthetics').numeric).toHaveLength(0);
    expect(scoreSummary(records, 'aesthetics').categories).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Website A better', count: 1, percentage: 50 })]));
  });
  it('never mixes incompatible scales', () => {
    const other = normalize(fixture('4'), source, { overall: { ...mappings.overall!, scale: 'other' } })!;
    expect(scoreSummary([...records, other], 'overall').numeric).toHaveLength(2);
  });
  it('discovers per-record scales only through explicitly configured metadata paths', () => {
    const mapping = { overall: { ...mappings.overall!, scalePath: 'rubric.name', minPath: 'rubric.min', maxPath: 'rubric.max' } };
    const small = normalize(fixture('scale-1', { rubric: { name: 'five-point', min: 1, max: 5 } }), source, mapping)!;
    const large = normalize(fixture('scale-2', { rubric: { name: 'ten-point', min: 1, max: 10 }, annotationData: '{"evaluation":{"overall":8}}' }), source, mapping)!;
    const missing = normalize(fixture('scale-3'), source, mapping)!;
    expect(scoreSummary([small, large, missing], 'overall').numeric).toEqual(expect.arrayContaining([
      expect.objectContaining({ scale: 'five-point:1:5 (annotation)', mean: 4, count: 1 }),
      expect.objectContaining({ scale: 'ten-point:1:10 (annotation)', mean: 8, count: 1 }),
    ]));
    expect(missing.scores.overall.scoringStatus).toBe('invalid');
  });
  it('deduplicates explicitly identified task-level results without mixing annotation-level scores', () => {
    const taskMapping = { overall: { ...mappings.overall!, level: 'task' as const, entityPath: 'latestTaskResult.id' } };
    const tasks = [normalize(fixture('task-1'), source, taskMapping)!, normalize(fixture('task-2'), source, taskMapping)!];
    expect(scoreSummary(tasks, 'overall').numeric[0]).toMatchObject({ mean: 4, count: 1 });
    const conflict = normalize(fixture('task-3', { annotationData: '{"evaluation":{"overall":5}}' }), source, taskMapping)!;
    expect(scoreSummary([...tasks, conflict], 'overall')).toMatchObject({ conflictingTasks: 1, numeric: [] });
    expect(scoreSummary([...tasks, record()], 'overall').numeric).toHaveLength(2);
    expect(normalize(fixture(), source, { overall: { ...taskMapping.overall, entityPath: 'missing' } })!.scores.overall.scoringStatus).toBe('invalid');
  });
  it('combines search status category score and identity filters', () => {
    expect(filterRecords(records, { ...emptyFilters, search: 'website', project: 'project-1', state: 'SUBMITTED', min: '3' }).map(r => r.id)).toEqual(['1']);
    expect(filterRecords(records, { ...emptyFilters, scored: 'no' }).map(r => r.id)).toEqual(['2']);
    expect(filterRecords(records, { ...emptyFilters, resultState: 'NOT_STARTED' })).toHaveLength(3);
    expect(distribution(records, r => r.state!)).toHaveLength(2);
  });
  it('uses inclusive UTC date boundaries and excludes undated rows', () => {
    const dates = [record('1', { createdAt: '2026-01-01T00:00:00Z' }), record('2', { createdAt: '2026-01-01T23:59:59.999Z' }), record('3', { createdAt: '2026-01-02T00:00:00Z' }), record('4', { createdAt: null })];
    expect(filterRecords(dates, { ...emptyFilters, from: '2026-01-01', to: '2026-01-01' }).map(r => r.id)).toEqual(['1', '2']);
  });
});
describe('privacy and exports', () => {
  it('redacts nested secrets including serialized JSON and URLs', () => {
    const result = redact({ Authorization: 'Bearer abc', nested: '{"access_token":"secret","url":"https://host.test/path?signature=secret#token"}', email: 'private@example.test' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private@');
    expect(() => endpointUrl('https://host.test/?token=bad')).toThrow();
    expect(() => endpointUrl('https://user:pass@host.test')).toThrow();
    expect(() => endpointUrl('http://public.test')).toThrow();
  });
  it('neutralizes formula injection and escapes quotes with UTF-8 data', () => {
    expect(csvCell(' =HYPERLINK("bad")')).toBe('"\' =HYPERLINK(""bad"")"');
    expect(csvCell('@SUM(1)')).toBe('"\'@SUM(1)"');
    expect(exportRecords([record('1', { title: 'ignored', inputData: '{"title":"café"}' })], 'csv')).toContain('café');
    expect(exportRecords([record()], 'csv')).toContain('annotation_id,title,project_id');
    expect(JSON.parse(exportRecords([record()], 'json'))).toHaveLength(1);
    expect(exportRecords([record(), record('2')], 'jsonl').split('\n')).toHaveLength(2);
    expect(exportStructured({ summary: { total: 2 } }, 'csv')).toContain('"summary.total","2"');
    expect(JSON.parse(exportStructured({ summary: { total: 2 } }, 'jsonl'))).toEqual({ summary: { total: 2 } });
  });
});
