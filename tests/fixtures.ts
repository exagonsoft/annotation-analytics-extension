import type { Mappings } from '../src/core/model';
export const fixture = (id = 'annotation-1', overrides: Record<string, unknown> = {}) => ({
  id, state: 'SUBMITTED', iterationId: 'iteration-1', type: 'ANNOTATION', templateId: 'template-1',
  projectId: 'project-1', createdAt: '2026-01-10T12:00:00Z', claimedAt: null, lastModifiedAt: '2026-01-10T13:00:00Z',
  inputData: JSON.stringify({ title: 'Aesthetics/Functionality/Overall Website Preference - 291' }),
  annotationData: JSON.stringify({ ATTEMPT_URL: 'https://platform.example/attempt/1', evaluation: { overall: 4, aesthetics: 'Website A better', functionality: 3 } }),
  latestTaskResult: { id: 'result-1', state: 'NOT_STARTED' }, iteration: { id: 'iteration-1' }, pipeline: { id: 'pipeline-1' }, ...overrides,
});
export const mappings: Mappings = {
  overall: { path: 'annotationData.evaluation.overall', kind: 'numeric', min: 1, max: 5, scale: 'rubric-v1', level: 'annotation' },
  aesthetics: { path: 'annotationData.evaluation.aesthetics', kind: 'categorical', level: 'annotation' },
};
