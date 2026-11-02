import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { AnnotationRecord, Filters, Settings, Snapshot, Source } from '../core/model';
import { defaultSettings, emptyFilters } from '../core/model';
import { db, getSettings } from '../core/storage';
import type { ReviewRun } from '../core/review';
import { emptyReviewFilters, type ReviewFilters } from '../core/review-analytics';

interface AppState {
  records: AnnotationRecord[];
  sources: Source[];
  snapshots: Snapshot[];
  reviewRuns: ReviewRun[];
  settings: Settings;
  filters: Filters;
  reviewFilters: ReviewFilters;
  ready: boolean;
  error: string;
  setFilters: (patch: Partial<Filters>) => void;
  setReviewFilters: (patch: Partial<ReviewFilters>) => void;
  setSettings: (settings: Settings) => void;
  report: (error: unknown) => void;
}
export const useApp = create<AppState>(set => ({
  records: [], sources: [], snapshots: [], reviewRuns: [], settings: defaultSettings, filters: emptyFilters, reviewFilters: emptyReviewFilters, ready: false, error: '',
  setFilters: patch => set(state => ({ filters: { ...state.filters, ...patch } })),
  setReviewFilters: patch => set(state => ({ reviewFilters: { ...state.reviewFilters, ...patch } })),
  setSettings: settings => set({ settings }),
  report: error => set({ error: error instanceof Error ? error.message : String(error) }),
}));
export function initialize(): () => void {
  const subscription = liveQuery(async () => ({
    records: await db.records.toArray(),
    sources: await db.sources.orderBy('collectedAt').reverse().toArray(),
    snapshots: await db.snapshots.orderBy('createdAt').reverse().toArray(),
    reviewRuns: (await db.reviewRuns.toCollection().sortBy('updatedAt')).reverse().slice(0, 20),
  })).subscribe({
    next: data => useApp.setState({ ...data, ready: true }),
    error: error => useApp.getState().report(error),
  });
  void getSettings().then(settings => useApp.setState({ settings })).catch(useApp.getState().report);
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes.settings) void getSettings().then(settings => useApp.setState({ settings })).catch(useApp.getState().report);
  };
  globalThis.chrome?.storage?.onChanged.addListener(listener);
  return () => { subscription.unsubscribe(); globalThis.chrome?.storage?.onChanged.removeListener(listener); };
}
export async function action(work: () => Promise<unknown>) {
  try { await work(); } catch (error) { useApp.getState().report(error); }
}
