import { z } from 'zod';
import { redact } from './privacy';
import type { AnnotationRecord } from './model';

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';
export const DETAIL_PATH = '/ai-trainer/api/frontendAnnotationTaskResults/';
export type ReviewStatus = string;
export interface AnnotationReview {
  annotationScore: number | null;
  status: ReviewStatus | null;
  feedback: string | null;
  reviewed: boolean;
}
export interface AnnotationDetail {
  id: number;
  taskId: number | null;
  state: string;
  projectId: number | null;
  iterationId: number | null;
  pipelineId: number | null;
  pipelineStageId: number | null;
  createdAt: number | null;
  claimedAt: number | null;
  endedAt: number | null;
  durationInSeconds: number | null;
  idleDurationInSeconds: number | null;
  review: AnnotationReview;
  warnings: string[];
}
export interface DetailError { at: string; status: number | null; message: string }
export interface DetailCollection {
  status: 'pending' | 'fetching' | 'complete' | 'failed';
  data: AnnotationDetail | null;
  attempts: number;
  errors: DetailError[];
  fetchedAt: string | null;
  lastAttemptAt: string | null;
  via: 'session' | 'devtools' | 'import';
  completedRunId?: string;
  attemptRunId?: string;
  verified?: boolean;
}
export interface ReviewCollectorConfig { concurrency: number; delayMs: number; maxRetries: number }
export type ReviewCollectionMethod = 'session' | 'website';
export const defaultReviewConfig: ReviewCollectorConfig = { concurrency: 1, delayMs: 1500, maxRetries: 2 };
export interface ReviewRun {
  id: string;
  status: 'running' | 'paused' | 'cancelled' | 'complete' | 'partial' | 'interrupted';
  startedAt: string;
  updatedAt: string;
  config: ReviewCollectorConfig;
  annotationIds: string[];
  refresh: boolean;
  requests: number;
  completed: number;
  failed: number;
  message: string;
  notBefore: number | null;
  diagnostics?: ReviewDiagnostics;
  method?: ReviewCollectionMethod;
  jobId?: string;
  runnerTabId?: number;
}
export interface DetailDiagnosticEvent {
  at: string;
  type: 'DETAIL_REQUEST_DISPATCHED' | 'DETAIL_REQUEST_STARTED' | 'DETAIL_REQUEST_SUCCESS' | 'DETAIL_REQUEST_FAILED';
  annotationId: string;
  path: string;
  status: number | null;
  error?: string;
}
export interface ReviewDiagnostics {
  discovered: number; eligible: number; skippedCache: number; queued: number;
  dispatched: number; started: number; completed: number; failed: number;
  httpCodes: Record<string, number>;
  latestEndpoint: string | null; latestError: string | null;
  executionContext: string;
  events: DetailDiagnosticEvent[];
}
export const reviewCollectorConfigSchema = z.object({
  concurrency: z.number().int().min(1).max(3),
  delayMs: z.number().finite().min(500).max(30_000),
  maxRetries: z.number().int().min(0).max(3),
});
const identifier = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const optionalId = identifier.nullish();
const timestamp = z.number().finite().nonnegative().max(8.64e15).nullish();
const duration = z.number().finite().nonnegative().nullish();
export const annotationDetailSchema = z.object({
  id: identifier, taskId: optionalId, state: z.string().trim().min(1).max(200),
  projectId: optionalId, iterationId: optionalId, pipelineId: optionalId, pipelineStageId: optionalId,
  pipeline: z.object({ id: optionalId }).nullish(),
  pipelineStage: z.object({ id: optionalId }).nullish(),
  createdAt: timestamp, claimedAt: timestamp, endedAt: timestamp,
  durationInSeconds: duration, idleDurationInSeconds: duration,
  currentVersionReview: z.object({
    annotationScore: z.unknown().optional(),
    status: z.string().max(200).nullish(),
    feedback: z.string().max(2_000_000).nullish(),
  }).nullish(),
});
export function annotationId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Review requests require a positive, safe annotation ID from the discovered listing.');
  return Number(value);
}
export function parseAnnotationDetail(payload: unknown, expectedId?: string): AnnotationDetail {
  const parsed = annotationDetailSchema.safeParse(payload);
  if (!parsed.success) throw new Error('Invalid annotation-detail JSON: required identity, state, review or timing fields have an unsupported type.');
  const value = parsed.data;
  if (expectedId !== undefined && value.id !== annotationId(expectedId)) throw new Error('Detail annotation ID does not match the discovered annotation ID. No data was merged.');
  const review = value.currentVersionReview;
  const numericScore = typeof review?.annotationScore === 'number' && Number.isFinite(review.annotationScore) ? review.annotationScore : null;
  const validScore = numericScore !== null;
  const feedback = review?.feedback === null || review?.feedback === undefined ? null : redact(review.feedback);
  return {
    id: value.id, taskId: value.taskId ?? null, state: value.state,
    projectId: value.projectId ?? null, iterationId: value.iterationId ?? null,
    pipelineId: value.pipelineId ?? value.pipeline?.id ?? null,
    pipelineStageId: value.pipelineStageId ?? value.pipelineStage?.id ?? null,
    createdAt: value.createdAt ?? null, claimedAt: value.claimedAt ?? null, endedAt: value.endedAt ?? null,
    durationInSeconds: value.durationInSeconds ?? null, idleDurationInSeconds: value.idleDurationInSeconds ?? null,
    review: {
      annotationScore: numericScore,
      status: typeof review?.status === 'string' && review.status.trim() ? String(redact(review.status.trim())) : null,
      feedback: feedback === null ? null : typeof feedback === 'string' ? feedback : JSON.stringify(feedback),
      reviewed: review !== null && review !== undefined,
    },
    warnings: review?.annotationScore !== null && review?.annotationScore !== undefined && !validScore ? ['Nonnumeric or nonfinite review score excluded.'] : [],
  };
}
export function detailCollection(data: AnnotationDetail, via: DetailCollection['via']): DetailCollection {
  return { status: 'complete', verified: true, data, attempts: 0, errors: [], fetchedAt: new Date().toISOString(), lastAttemptAt: null, via };
}
export function hasReviewFields(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  return typeof review.annotationScore === 'number' && Number.isFinite(review.annotationScore) ||
    typeof review.status === 'string' && !!review.status.trim() ||
    typeof review.feedback === 'string' && !!review.feedback.trim();
}
export function isDetailPayload(value: Record<string, unknown>, url: string): boolean {
  if (hasReviewFields(value.currentVersionReview)) return true;
  try { const endpoint = new URL(url); return endpoint.origin === LINKEDIN_ORIGIN && endpoint.pathname === `${DETAIL_PATH}${value.id}`; }
  catch { return false; }
}
export function hasCachedDetail(record: AnnotationRecord): boolean {
  return record.detail?.verified === true && !!record.detail.data;
}
export function shouldSkipCachedDetail(record: AnnotationRecord, refresh: boolean, runId?: string): boolean {
  return hasCachedDetail(record) && (!refresh || !!runId && record.detail?.completedRunId === runId);
}
export function repairDetailCache(record: AnnotationRecord): AnnotationRecord {
  const entry = record.detail;
  if (!entry?.data || entry.verified === true) return record;
  const raw = record.rawPayload && typeof record.rawPayload === 'object' && !Array.isArray(record.rawPayload) ? record.rawPayload : {};
  const verified = !!entry.completedRunId || hasReviewFields(entry.data.review) || isDetailPayload(raw, record.source.url);
  return { ...record, detail: verified ? { ...entry, verified: true } :
    { ...entry, verified: false, data: null, fetchedAt: null, status: entry.status === 'failed' ? 'failed' : 'pending' } };
}
export function reviewDiagnosticsReport(run: ReviewRun, preparationError = ''): string {
  return JSON.stringify(redact({
    schemaVersion: 1, runId: run.id, state: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt,
    message: run.message, preparationError: preparationError || null, notBefore: run.notBefore, config: run.config, diagnostics: run.diagnostics ?? null,
  }), null, 2);
}
export function mergeReviewRecord(record: AnnotationRecord, entry: DetailCollection): AnnotationRecord {
  const data = entry.data;
  if (!data) return { ...record, detail: entry };
  return {
    ...record, detail: entry, taskId: data.taskId === null ? record.taskId : String(data.taskId),
    state: data.state, projectId: data.projectId === null ? record.projectId : String(data.projectId),
    iterationId: data.iterationId === null ? record.iterationId : String(data.iterationId),
    createdAt: data.createdAt === null ? record.createdAt : new Date(data.createdAt).toISOString(),
    claimedAt: data.claimedAt === null ? record.claimedAt : new Date(data.claimedAt).toISOString(),
    pipeline: data.pipelineId === null ? record.pipeline : { id: data.pipelineId },
  };
}
export function detailPayload(data: AnnotationDetail): Record<string, unknown> {
  const { review, ...metadata } = data;
  return {
    ...metadata, pipeline: data.pipelineId === null ? null : { id: data.pipelineId },
    pipelineStage: data.pipelineStageId === null ? null : { id: data.pipelineStageId },
    currentVersionReview: review.reviewed ? { annotationScore: review.annotationScore, status: review.status, feedback: review.feedback } : null,
  };
}
export function importedDetail(value: unknown, id: string): DetailCollection | null {
  const result = z.object({ data: z.object({ review: z.object({ reviewed: z.boolean() }).passthrough() }).passthrough(), fetchedAt: z.string().nullable().optional(), verified: z.boolean().optional(), completedRunId: z.string().optional() }).safeParse(value);
  if (!result.success) return null;
  const raw = result.data.data;
  if (!result.data.verified && !result.data.completedRunId && !hasReviewFields(raw.review)) return null;
  const data = parseAnnotationDetail({ ...raw, currentVersionReview: raw.review.reviewed ? raw.review : null }, id);
  const entry = detailCollection(data, 'import');
  if (result.data.fetchedAt && Number.isFinite(Date.parse(result.data.fetchedAt))) entry.fetchedAt = new Date(result.data.fetchedAt).toISOString();
  return entry;
}
