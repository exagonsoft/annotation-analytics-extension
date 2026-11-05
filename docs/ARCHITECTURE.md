# Architecture

## Boundaries

All interfaces share the extension origin's IndexedDB. There is no backend.

```text
DevTools page -- getContent --> parse / normalize / redact --+
Dashboard API GET ----------> discover pagination ----------+--> IndexedDB
User JSON/JSONL import ------> parse / normalize / redact ---+       |
Injected DOM observer -------> worker message --> normalize +       |
                                                                  v
Popup / side panel / dashboard / DevTools panel <--- Dexie liveQuery
                                  |
                      filters --> analytics --> charts / export
```

## Entry points

| File | Responsibility |
|---|---|
| `public\manifest.json` | MV3, minimum permissions, optional hosts, local CSP |
| `src\extension\background.ts` | Serialized, sender-validated DOM ingestion; side-panel setup |
| `src\extension\devtools.ts` | Panel registration and documented response-body access |
| `src\extension\dom.ts` | Self-contained, explicitly injected isolated-world collector |
| `src\main.tsx` / `src\App.tsx` | Shared React shell, entry-point-specific surfaces, error boundary |
| `src\core` | Strict domain types, Zod object validation, privacy, analytics, persistence, export |
| `src\collectors` | Bounded API collection, related-result joins, import |
| `src\collectors\AnnotationDetailCollector.ts` | Persisted ID-only reviewer enrichment queue, retries, pacing and Web Lock |
| `collection.html` / `src\extension\collection-runner.ts` | User-started non-active tab that owns review ingestion independently of visible interfaces |
| `src\collectors\review-jobs.ts` | Validated session job launch/start acknowledgment, Pause/Cancel messaging and interruption recovery |
| `src\core\finance.ts` / `finance-storage.ts` | Validated USD deliverables, exact-cent accounting, corrections, financial persistence and mapping checks |
| `src\collectors\greenlight.ts` | Authorized portal-tab discovery, allowlisted rendered data and bounded native week navigation |
| `src\ui\Financials.tsx` | Cached paid/pending summaries, filtered ledger/exports and explicit batch reconciliation |
| `src\collectors\detail-session.ts` | Self-contained isolated-world same-origin detail GET and cancellation bridge |
| `src\collectors\website-session.ts` | User-started native task-link clicks/navigation, safe capture tickets and response correlation; no direct API fetch |
| `src\ui` | Accessible native controls, Radix dialogs, Zustand projection, Recharts |

Vite emits stable `assets\background.js` and `assets\dom.js` names for manifest and scripting references. Shared module chunks are packaged locally. The content script has no module imports because injected content scripts are not module scripts.

## State and concurrency

IndexedDB is authoritative for records, source runs, and snapshots. Zustand holds the current materialized query, filters and settings for one interface. Dexie `liveQuery` propagates writes across extension contexts. Chrome Storage changes refresh settings in each open interface.

Ingestion is transactional: deduplicate by stable key, protect richer network records from DOM summaries, update source counters, then commit. Same-tab DOM messages and DevTools requests are serialized to prevent a source run from overwriting its own progress. Network errors do not roll back earlier pages.

Collectors belong to their initiating context. API collection is cancelled when leaving Sources or closing its interface. DevTools capture requires DevTools to remain open. DOM collection lasts until stopped, navigation destroys the script, or the tab closes; a fresh injection is needed after a full navigation.

Review enrichment runs in a user-started, non-active `collection.html` tab, not in the initiating interface or suspendable MV3 worker. Chrome automatic discarding is disabled for this tab; it does not promise execution during browser/device suspension. Validated session-storage configuration carries only IDs/settings/target-tab identity, never credentials or response bodies. The runner acknowledges startup after its first IndexedDB progress write. Runtime messages matched by job UUID control Pause/Cancel. Each result/error and progress update is persisted; the runner closes when stopped. The worker marks running jobs interrupted when their tab closes or Chrome/extension restarts. Explicit Resume creates another runner for the saved run and skips its completed results. No automatic startup or polling occurs. A Web Lock prevents concurrent collectors. See [review collection](REVIEW_COLLECTION.md).

Dashboard and compact surfaces are read-only projections of IndexedDB, which is the application's source of truth even offline, not an API cache fallback. The primary Dashboard renders saved-review statistics, feedback, filters and exports over all saved annotations, including list-only/unknown-origin imports. Collection eligibility affects ingestion, not record visibility. Task-answer analytics remain separately in Results. Review filters are shared by Dashboard/Review Analytics and their exports; compact views summarize the whole saved dataset. Dexie live queries update every interface incrementally as ingestion writes. Navigating away or closing the initiating interface never pauses a background job.

Results has an explicit reviewer-scores/task-answers selector. Cached review details take precedence for the default view; a task-answer-only dataset retains its existing default. Explicit user selection overrides that choice. Reviewer mode reuses the saved-review analytics and matching export/filter scope; task-answer mode retains its own filters and export semantics. Missing mapped answers suppress the answer-score widgets and charts, while actual workload counts remain visible. Review scores are never copied into `scores.overall` to fill those widgets.

Website-driven review collection reuses that queue with enforced concurrency one, no retries and conservative pacing after each attempt. A DOM helper clicks matching task anchors; absent anchors use normal task-page navigation. The website owns its requests and authentication. DevTools correlates exact, fresh detail GETs using a short-lived session-storage ticket and acknowledges only after IndexedDB ingestion. The queue then verifies the saved detail before reporting success. Method choice persists in the run without an IndexedDB schema change; legacy runs default to direct session requests. Closing DevTools, leaving AI Trainer or cancelling removes listeners and stops further navigation. The service worker still makes no review requests.

## Scale

Greenlight financials uses separate schema-4 stores and per-tab native capture flags. DevTools routes recognized supplier-time responses to an allowlisted financial parser rather than annotation discovery. The website supplies its own authorization; the extension never extracts tokens or issues Greenlight API fetches. DOM reads capture displayed amounts and rates only. Financial DOM observations and API deliverables are not summed together. Explicit mappings reconcile aggregate batch counts with saved annotation scopes for labeled unbilled estimates; they do not establish individual paid task identities. See [Financials](FINANCIALS.md).

Schema 5 recovers surviving local batch metadata without collection. Allowlisted pipeline names and stage work types survive detail transport, normalization and cache merges. Financials derives exact batch matches from both caches, preserving Set/date and reporting ambiguous scopes and uncertain counts; it does not assign individual paid IDs or infer financial rates.

Schema 6 persists shared normalized join keys and a minimal project-scoped pipeline/stage catalog. Detail capture/import repairs other cached annotations using pipeline identity or a unique stage iteration, without task requests or review-cache invalidation. Explorer payment filters and exports use full-cache batch coverage; remaining submitted work subtracts paid counts, including work already present in pending deliverables.

Observed earnings projections reuse full-cache reconciliation and eligible paid deliverables from the same batch/work type. Exact paid-cent/count ratios are multiplied before final cent rounding; mixed amounts are excluded rather than allocated. Actual pending USD is combined only with unaccounted-work estimates, never with an estimate already including pending tasks. Optional confirmed-rate projections remain separate. Summary, batch table and financial JSON reports expose evidence and unavailable estimates without new collection or storage migrations.

The annotation table uses TanStack virtualization inside server-independent local pagination. IndexedDB indexes identity, project, state and date. The browser loads the current dataset into memory to compute combined filters and charts. This is intended for thousands to tens of thousands of moderate-size records, not an unlimited data warehouse.

Response pages are bounded at 20 MB, imports at 50 MB, nested redaction depth at 25, individual text fields at 2 MB, and request loops at at most 1,000 pages. Snapshots duplicate payloads and consume disk. Quota errors surface rather than pretending data was saved. There is no `unlimitedStorage` permission.

For much larger deployments, move aggregation and indexed filtering into a worker and stream exports; do not remove safety limits without measuring memory and storage costs.

## Error behavior

User actions report errors in an accessible alert. API runs persist a partial/failed source with safe diagnostics. Raw HTTP response text, authentication material and request headers are not logged. An error boundary retains the database and offers reload when rendering fails.

## Schema strategy

The Dexie database is version 6. Version 2 retains version 1 stores, adds task/detail indexes and `reviewRuns`, canonicalizes LinkedIn annotation IDs and recovers existing review data. Version 3 repairs false-complete list-derived caches and marks interrupted old runs. Version 4 adds financial payments, captured periods, rendered observations and explicit batch mappings without replacing annotation data. Versions 5 and 6 add local batch recovery and the minimal catalog/shared keys described above. New annotation snapshots still carry `schemaVersion: 2`; restoration supports versions 1 and 2 and validates review provenance. Financials is a separate dataset and is not included in annotation snapshots. Future schema changes require a Dexie migration and explicit older-snapshot adapter. Unsupported versions are rejected. Imported task-answer scores are reparsed from redacted raw data; normalized review details are separately validated against the confirmed contract.
