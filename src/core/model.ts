import type { DetailCollection, ReviewCollectorConfig } from './review';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Dimension = 'aesthetics' | 'functionality' | 'overall';
export type Method = 'devtools' | 'api' | 'dom' | 'import';
export interface Mapping {
  path: string;
  kind: 'numeric' | 'categorical';
  min?: number;
  max?: number;
  scale?: string;
  scalePath?: string;
  minPath?: string;
  maxPath?: string;
  categories?: string[];
  level: 'annotation' | 'task';
  entityPath?: string;
}
export type Mappings = Partial<Record<Dimension, Mapping>>;
export interface Score {
  value: number | string | null;
  scale: string | null;
  scoreSource: string | null;
  scoringStatus: 'missing' | 'invalid' | 'verified';
  level: 'annotation' | 'task';
  entityId: string | null;
}
export interface Source {
  id: string;
  method: Method;
  url: string;
  collectedAt: string;
  httpMethod?: string;
  status?: number;
  reportedTotal: number | null;
  completeness: 'partial' | 'complete' | 'failed';
  pages: number;
  received: number;
  uniqueRecords: number;
  requests: number;
  duplicates: number;
  errors: number;
  diagnostics: string[];
}
export interface AnnotationRecord {
  key: string;
  id: string;
  taskId: string | null;
  projectId: string | null;
  iterationId: string | null;
  templateId: string | null;
  type: string | null;
  state: string | null;
  createdAt: string | null;
  claimedAt: string | null;
  lastModifiedAt: string | null;
  title: string | null;
  taskUrl: string | null;
  attemptUrl: string | null;
  inputData: Json;
  annotationData: Json;
  latestTaskResult: Json;
  pipeline: Json;
  iteration: Json;
  scores: Record<Dimension, Score>;
  source: Source;
  rawPayload: Json;
  warnings: string[];
  detail: DetailCollection | null;
}
export interface Filters {
  search: string;
  from: string;
  to: string;
  project: string;
  iteration: string;
  pipeline: string;
  template: string;
  state: string;
  resultState: string;
  type: string;
  scored: string;
  source: string;
  category: string;
  min: string;
  max: string;
  scale: string;
}
export const emptyFilters: Filters = {
  search: '', from: '', to: '', project: '', iteration: '', pipeline: '', template: '',
  state: '', resultState: '', type: '', scored: '', source: '', category: '', min: '', max: '', scale: '',
};
export interface Settings {
  mappings: Mappings;
  endpoint: string;
  pageLimit: number;
  delayMs: number;
  presets: { name: string; filters: Filters }[];
  columns: string[];
  reviewCollector: ReviewCollectorConfig;
}
export const defaultSettings: Settings = {
  mappings: {}, endpoint: '', pageLimit: 100, delayMs: 500, presets: [],
  columns: ['id', 'title', 'projectId', 'iterationId', 'state', 'type', 'createdAt', 'lastModifiedAt', 'aesthetics', 'functionality', 'overall', 'availability', 'source'],
  reviewCollector: { concurrency: 1, delayMs: 1500, maxRetries: 2 },
};
export interface Snapshot {
  id: string;
  name: string;
  createdAt: string;
  schemaVersion: number;
  records: AnnotationRecord[];
  sources: Source[];
  mappings: Mappings;
}
