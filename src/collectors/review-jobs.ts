import { z } from 'zod';
import { liveQuery } from 'dexie';
import { db } from '../core/storage';
import { hasCachedDetail, reviewCollectorConfigSchema, type ReviewRun } from '../core/review';
import { selectedTab } from './target-tab';

export const reviewJobSchema = z.object({
  id: z.string().uuid(),
  method: z.enum(['website', 'session']),
  config: reviewCollectorConfigSchema,
  refresh: z.boolean(),
  tabId: z.number().int().positive().nullable(),
  resumeId: z.string().uuid().optional(),
  annotationIds: z.array(z.string().regex(/^[1-9]\d*$/)).optional(),
});
export type ReviewJob = z.infer<typeof reviewJobSchema>;
export const reviewJobKey = (id: string) => `review-job:${id}`;
const acknowledgementSchema = z.object({
  state: z.enum(['ready', 'failed']),
  runId: z.string().uuid().optional(),
  error: z.string().optional(),
});
export async function launchReviewJob(options: Omit<ReviewJob, 'id' | 'tabId'>): Promise<{ jobId: string; runId: string }> {
  const request = reviewJobSchema.parse({ ...options, id: crypto.randomUUID(), tabId: await selectedTab() });
  const key = reviewJobKey(request.id);
  let stop = () => {};
  const acknowledgement = new Promise<{ runId?: string; error?: string }>(resolve => {
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      const parsed = acknowledgementSchema.safeParse(changes[key]?.newValue);
      if (parsed.success) resolve(parsed.data.state === 'ready' && parsed.data.runId ? { runId: parsed.data.runId } :
        { error: parsed.data.error ?? 'Background collection could not start.' });
    };
    const timer = setTimeout(() => resolve({ error: 'The background collection tab did not initialize within 20 seconds.' }), 20_000);
    chrome.storage.onChanged.addListener(changed);
    stop = () => { clearTimeout(timer); chrome.storage.onChanged.removeListener(changed); };
  });
  let tabId: number | undefined;
  try {
    await chrome.storage.session.set({ [key]: request });
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`collection.html?job=${request.id}`), active: false });
    tabId = tab.id;
    if (!tabId) throw new Error('Chrome did not create the background collection tab.');
    const result = await acknowledgement;
    if (result.error || !result.runId) throw new Error(result.error ?? 'Background collection returned no saved run.');
    return { jobId: request.id, runId: result.runId };
  } catch (error) {
    if (tabId !== undefined) {
      const tabs = await chrome.tabs.query({});
      if (tabs.some(tab => tab.id === tabId)) await chrome.tabs.remove(tabId);
    }
    await chrome.storage.session.remove(key);
    throw error;
  } finally { stop(); }
}
export async function controlReviewJob(run: ReviewRun, command: 'pause' | 'cancel'): Promise<void> {
  if (!run.jobId) throw new Error('This saved queue has no active background job. Resume it explicitly.');
  const reply: unknown = await chrome.runtime.sendMessage({ type: 'REVIEW_JOB_CONTROL', jobId: run.jobId, command });
  if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) throw new Error('The background job did not acknowledge the command. Saved results remain available.');
}
export function waitForReviewRun(runId: string): Promise<ReviewRun> {
  return new Promise((resolve, reject) => {
    const subscription = liveQuery(() => db.reviewRuns.get(runId)).subscribe({
      next: run => {
        if (run && run.status !== 'running') { clearTimeout(timer); subscription.unsubscribe(); resolve(run); }
      },
      error: error => { clearTimeout(timer); subscription.unsubscribe(); reject(error); },
    });
    const timer = setTimeout(() => { subscription.unsubscribe(); reject(new Error('Collection is still pending. Inspect its saved progress; no automatic retry was made.')); }, 90_000);
  });
}
export async function interruptReviewJobs(runnerTabId?: number): Promise<void> {
  await db.transaction('rw', db.reviewRuns, db.records, async () => {
    const runs = await db.reviewRuns.where('status').equals('running').filter(run => runnerTabId === undefined || run.runnerTabId === runnerTabId).toArray();
    for (const run of runs) {
      await db.reviewRuns.update(run.id, { status: 'interrupted', message: 'Collection tab closed or extension restarted. Saved data is retained; resume explicitly.' });
      await db.records.where('detail.status').equals('fetching').filter(record => record.detail?.attemptRunId === run.id).modify(record => {
        if (record.detail) record.detail.status = hasCachedDetail(record) ? 'complete' : 'pending';
      });
    }
  });
}
