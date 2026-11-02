# Review requests: diagnosis and real-session validation

## Fixed execution defects

The previous normalizer treated `endedAt` plus `taskId`, or the mere presence of `currentVersionReview` (including null), as proof that a detail response had been collected. Completed-list rows could therefore become `detail.status: complete` with empty review data. The queue skipped every such row because it only checked whether `detail.data` existed, then reported a completed zero-request queue.

The normalizer now requires a matching confirmed detail endpoint or meaningful confirmed review fields. The queue requires explicit verified detail provenance for cache skips. IndexedDB schema 3 requeues ambiguous legacy empty-review caches, including snapshots, without deleting annotation rows; actual successful session details and known review results are retained. Legitimate no-review detail responses remain cacheable. Ambiguous old no-review captures may need one explicit refetch because their original provenance was not preserved.

Two UI wiring defects were also fixed: Sources' Fetch Review Scores used to only open another page, and DevTools navigation lost the requested review route/inspected tab. Sources now explicitly launches an independently owned, non-active collection tab. Normal navigation never starts collection.

Chrome injection failures previously became a generic access error, and failed queues could be labeled finished without sufficient evidence. Browser execution failures now retain a sanitized error, HTTP failures retain their status, partial failures are labeled partial/paused, and a cache-only queue explicitly reports zero queued requests and its skip count.

## Exact production path

```text
Sources: Fetch Review Scores (or Review Analytics: Fetch Review Scores)
  -> ReviewCollectionControls.start
  -> launchReviewJob: validated configuration in session storage; create inactive collection.html tab
  -> collection-runner: owns queue; acknowledge first saved progress; retain job/runner identity
  -> AnnotationDetailCollector.start + cross-context Web Lock
  -> scan IndexedDB records; select annotation id, LinkedIn source, verified cache state
  -> bounded, paced per-ID queue
  -> use selected/inspected target tab only for actual queued requests
  -> websiteDetailTransport (default): native task navigation -> website GET -> DevTools -> IndexedDB
     OR sessionDetailTransport (explicit direct API):
  -> chrome.scripting.executeScript, ISOLATED world, selected tab
  -> exact origin/path guard
  -> relative GET /ai-trainer/api/frontendAnnotationTaskResults/{annotationId}
  -> confirmed JSON validation + incremental IndexedDB merge
  -> Dexie liveQuery -> Zustand -> review metrics/table
```

The annotation's `id` is used. `taskId`, `iterationId`, `projectId` and `nextResultId` are never endpoint arguments. Dashboard, popup and side panel only read saved IndexedDB data; task-answer scores remain separately in Results. Closing/navigating the initiating interface does not stop ingestion. Pause/Cancel commands go to the UUID-matched runner; closing its tab or restarting Chrome persists an interrupted state for explicit Resume.

IndexedDB selection is authoritative, not the current chart filters or a possibly lagging UI record count. A no-ID queue produces a persisted, exportable blocked diagnostic without attempting to resolve or fetch from a website tab.

There is no background-service-worker fetch proxy. For explicit direct API mode, the website's isolated content-script context makes a same-origin GET with browser-managed session credentials and an AbortSignal; only Accept is supplied. The worker manages interruption recovery and DOM ingestion, not review requests. The injected function sends a small `DETAIL_REQUEST_STARTED` runtime message to the collection runner; request ID, annotation ID, tab and frame are matched before acknowledging it.

The temporary activeTab grant requires opening the popup on the correct website. If the dashboard was opened only through DevTools or that grant expired, explicitly choose **Grant LinkedIn collection access**, or reopen the popup on the correct tab and reopen its dashboard. That optional permission covers only `https://www.linkedin.com/*`. It does not authenticate the user or override server restrictions. 401/403/429 pauses are not bypassed.

## Website GET succeeds but collection returns 403

**Automatic native-UI option:** open DevTools on the authorized website tab, then choose **Review Analytics -> Collect through website**. This user-started action clicks discovered task links or opens their normal task pages and waits for the website's response to be captured. It never replays the refused direct API request. Pause/Resume/Cancel use the existing saved queue; Resume preserves website mode. If the website's own request is refused, collection stops rather than trying another context. See [website-driven collection](REVIEW_COLLECTION.md#website-driven-collection).

User-reported browser evidence confirms that normal website navigation can return HTTP 200 JSON from the exact annotation-detail endpoint while the collector returns HTTP 403. The supplied response identifies annotation 7901345, task 4010128, score 4, status APPROVED and available feedback. No session credentials or private response content are retained in this guide or test fixtures.

The native request includes an application-supplied CSRF header. The collector supplies only Accept: browser-managed cookie inclusion does not generate application CSRF headers. This is a plausible compatibility difference, not proof of the server's rejection reason. A 403 alone does not establish an expired login, a rate limit, or a specific CSRF failure. The collector now displays distinct authentication (401), access-refusal (403) and rate-limit (429) guidance in its run message, persisted per-record error and sanitized diagnostics.

Do not copy the header, read a token from cookies/page state, replay a captured request, change execution worlds to evade a refusal, or keep resuming a blocked queue. Keep bulk collection paused and use the website's normal request:

1. Open DevTools on the authorized AI Trainer website tab and select its Annotation Analytics panel.
2. In Sources choose **Start capture**, leaving DevTools open.
3. Reopen the annotation through the normal website UI so a new detail response completes after capture was armed.
4. Open Review Analytics and verify the existing annotation row's collection status, score, review status and feedback. The detail merges by annotation ID, retaining its separate task ID and any prior request error history.

Alternatively, import the response JSON in Sources with its original detail response URL. Do not import request headers, a HAR, or Copy-as-fetch/cURL output. Passive capture only enriches responses the website actually loads; it does not fetch all discovered IDs or establish global completeness.

The user's native HTTP 200 and direct collector HTTP 403 are reported evidence, not a successful developer-run authenticated bulk test. The website-driven mechanism is browser-tested against synthetic routed pages and actual Chrome DevTools capture, not the real account. Actual capture of that user's response and successful native bulk collection remain unverified. If credentials were accidentally shared, revoke active website sessions and remove the sensitive material wherever possible; never save it in this repository or diagnostics.

## Read diagnostics, not assumptions

Review Analytics includes discovered/eligible IDs, cache skips, queue length, dispatch attempts, confirmed GET starts, completions, failures, HTTP-code counts, latest endpoint/error, state and execution context. Bulk collection ignores chart filters; only explicit selected refresh or the single-ID diagnostic restricts the queue.

Dispatch means an attempt to invoke Chrome scripting. It is not proof of a network request. Started is reported by the injected fetch context; a completed result can also recover that confirmation if the runtime event was unavailable. A missing permission can therefore show dispatched 1, started 0, no HTTP codes and an explicit browser error. Completed counts settled browser requests; failed includes failed dispatches and retries. Retries can produce more attempts than unique annotations. The latest 200 safe events and counters are persisted; resume retains their history.

Use **Export sanitized diagnostics**. It contains paths, IDs, statuses, configuration and safe events/errors, not cookies, headers, response bodies, profiles or feedback. Preparation errors are included separately. Do not send an unredacted HAR, Copy-as-fetch/cURL output, credentials or profile data.

## Development-only single request

```powershell
npm run build:diagnostic
```

Reload the unpacked extension at `chrome://extensions`, then reopen its dashboard from the popup on your authorized AI Trainer tab. Under Review Analytics, **Development-only live diagnostic** contains **Test Annotation Detail Request**.

Enter an annotation ID already discovered from your LinkedIn listing. The diagnostic uses the same production collector, origin guard, transport, parser and persistence as bulk collection. It forces refresh of that ID only, uses concurrency 1 and zero retries, and still respects any existing server cooldown. It displays the HTTP result, saved score/status and whether feedback is available. It cannot enumerate arbitrary IDs and contains no mock or fixture response path.

`npm run build` / `npm run package` returns to the production build, which does not display this development control. Normal **Force Refresh Selected Reviews** remains available: select rows in the review table and invoke that explicit action.

## Where GET requests appear

Open DevTools **on the selected LinkedIn AI Trainer website tab before starting collection**, select Network, enable Preserve log if navigating, remove unrelated filters and search for `frontendAnnotationTaskResults`. These same-origin isolated-world fetches belong to that tab. Verify the Request URL's annotation ID, GET method and actual status. The website Console may explain network/CSP/redirect restrictions behind a `TypeError: Failed to fetch`; do not infer a 401/403 when no HTTP response exists.

The dashboard's own DevTools Console (right-click its extension page -> Inspect) shows the safe forwarded `DETAIL_REQUEST_STARTED`, `DETAIL_REQUEST_SUCCESS` and `DETAIL_REQUEST_FAILED` events. Its Application -> IndexedDB -> `annotation-analytics` -> `records` shows the merged detail; refresh the IndexedDB view after a write.

For comparison, the generic Sources API connector runs from the extension page and its requests belong in that extension page's Network panel. It is not the review transport.

To inspect the background worker, open `chrome://extensions`, enable Developer mode, find Annotation Analytics, then click its **service worker / Inspect** link (or Details -> Inspect views). That worker does not issue review GETs: absence from its Network panel is expected and is not evidence that the website-tab collector did or did not run. Use the independent collection diagnostics.

## Real authorized-session acceptance procedure

**Status: every real LinkedIn check below is NOT VERIFIED in this development environment. No signed-in LinkedIn browser session was available or used.**

1. Build the diagnostic extension, reload it, and navigate to LinkedIn AI Trainer's completed tasks using your normal authorized account.
2. Open the extension popup on that tab. Collect the list through its supported real pagination/capture workflow. In Review Analytics confirm discovered and eligible counts are positive; an unknown-origin import must first be reimported with its original LinkedIn response URL.
3. Keep the website tab and the user-started collection tab open. Open the website's Network panel. In Review Analytics enter a discovered annotation ID, such as 7901345 only if it is in your actual listing, and click Test Annotation Detail Request.
4. Confirm diagnostics records a started event and the browser records GET `/ai-trainer/api/frontendAnnotationTaskResults/7901345`, never `/4010128`. Inspect the actual HTTP status.
5. On 200 JSON, verify the displayed score/status against `currentVersionReview.annotationScore` / `.status`; verify the feedback-available indicator. Inspect the matching IndexedDB row's verified detail, fetched timestamp, review and separate task ID.
6. On 401/403/429, confirm the queue pauses after that attempt. On a browser restriction, confirm no HTTP status is invented. Respect Retry-After; use normal website DevTools capture or saved-response import if the platform does not allow this request context. Do not supply credential/CSRF headers.
7. Start bulk Fetch Review Scores. Confirm multiple distinct discovered annotation IDs are requested at the configured pace, counters update and each success persists incrementally.
8. Pause, resume and cancel. Confirm saved successes are skipped; select a saved row and Force Refresh Selected Reviews to prove an explicit recheck is sent.
9. Confirm average/status counts and feedback inspection update from actual responses. Refresh/reopen the dashboard and verify persistence. A complete loaded-ID queue is still not proof of global listing completeness.
10. Export the sanitized diagnostics and retain the actual outcome (including failures) as validation evidence. Do not mark real integration verified solely from automated tests.

## Automated coverage versus real access

Regression tests reproduce list-default false caches and schema-2 repair. Chromium tests invoke the built UI, queue and compiled production transport for multiple IDs, force refresh and diagnostics export. The production-path test routes synthetic responses and a synthetic HttpOnly session in an isolated profile; no request is sent to LinkedIn. A separate local fixture tests the self-contained fetch function through Chrome scripting. Development-build tests also exercise the single-request control.

These are automated implementation checks, not the real authorized-session acceptance checks above. Native permission prompts, actual LinkedIn authentication/CSRF policy, endpoint behavior and production listing scope remain unverified.

## Website-driven real-session validation

This new workflow is **NOT VERIFIED against a real signed-in LinkedIn account**. Automated Chromium tests use actual website-page execution and Chrome DevTools capture, with all LinkedIn-shaped pages and responses fulfilled by synthetic fixtures.

1. Reload the unpacked production `dist` extension. Close and reopen DevTools on the authorized AI Trainer tab so the updated DevTools integration is loaded. Open the extension popup on that tab.
2. Confirm annotation IDs from the authorized listing are already present. In Sources or Review Analytics choose **Collect through website**. It opens a non-active collection tab, arms capture and navigates the selected website. Keep the collection tab, website and DevTools open. Navigate the dashboard or close its initiating interface and confirm ingestion continues.
3. Confirm an existing matching task link is clicked, or the normal `/ai-trainer/tasks/{annotationId}` page opens. Observe the website's own GET in its Network panel. No extension-generated fetch or copied authentication header should be involved.
4. On a successful native JSON response, confirm diagnostics receives its actual HTTP status, the matching annotation row shows verified detail and review fields, and the task ID remains separate. Compare the score/status with the website, without sharing headers or private feedback.
5. After some successes, Pause. Reopen Review Analytics and Resume saved queue. Confirm website mode is preserved, saved details are skipped, distinct remaining IDs open sequentially, and the dashboard updates incrementally.
6. Cancel to stop further navigation. If the site denies a native request or requires login/access verification, keep collection paused and resolve it through the normal website; do not repeatedly resume or change contexts. Capture only covers responses the website actually loads, not a proof of global listing completeness.

## Files changed for this fix

| Files | Change |
|---|---|
| `src\core\review.ts`, `src\core\storage.ts` | Verified cache evidence, classification fix, schema-3 repair, diagnostics contracts/export, independent review preferences |
| `src\collectors\AnnotationDetailCollector.ts`, `src\collectors\detail-session.ts` | ID queue/selection, dispatch versus actual start, runtime confirmation, safe execution/HTTP errors, partial state |
| `src\ui\ReviewAnalytics.tsx`, `src\ui\Sources.tsx`, `src\App.tsx` | Actual start wiring, diagnostics/export, developer single-ID action, selected refresh, permission control, preserved inspected tab |
| `src\styles.css`, `package.json`, `tsconfig.json` | Diagnostic readability, explicit development build, Vite environment typing |
| `tests\reviews.test.ts`, `tests\integration\extension.spec.ts` | False-cache/migration/empty-list regressions, safe diagnostics, compiled bulk/single pipeline checks |
| `README.md`, `docs\ARCHITECTURE.md`, `docs\DATA_MODEL.md`, `docs\REVIEW_COLLECTION.md`, `docs\VALIDATION.md`, this guide | Updated workflow, provenance, execution context, evidence and NOT VERIFIED manual acceptance |
