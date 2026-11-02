# LinkedIn reviewer quality collection

## Two stages, no ID enumeration

Stage A uses the existing Sources collectors to discover and persist the annotation listing. Verify the actual listing endpoint, pagination metadata and scoped server total; a visible page is not the whole listing. Supported cursor/page/offset/next-link contracts are described in [API discovery](API_DISCOVERY.md). No actual production listing endpoint or listing pagination contract has been verified here.

Stage B requests only numeric annotation IDs already stored from `https://www.linkedin.com`. It deduplicates by annotation ID, not task ID, project or title. It does not increment IDs, scrape unrelated users, or follow `nextResultId`. Sources' Fetch Review Scores starts that queue in a non-active extension collection tab. Opening Dashboard, popup or Review Analytics never starts a queue; their source of truth is the saved local database.

The confirmed GET route is:

```text
https://www.linkedin.com/ai-trainer/api/frontendAnnotationTaskResults/{annotationId}
```

In the sanitized test contract, annotation 7901345 relates to task 4010128; the request uses 7901345. Unknown-origin list imports cannot initiate live enrichment: import them with the original LinkedIn response URL. Imported/captured review details can still be analyzed without live requests.

## Website-driven collection

After discovering annotation IDs, open the popup on the signed-in AI Trainer tab and open DevTools on that same tab. In Review Analytics choose **Collect through website**. This explicitly arms capture and runs the existing persisted queue through the normal website, without generating detail API requests or reading cookies, tokens, page globals or request headers.

For each known ID the injected DOM helper clicks an existing visible, same-tab anchor whose origin and `/ai-trainer/tasks/{annotationId}` path match exactly. It never clicks submission buttons or arbitrary selectors. If no such anchor is rendered, Chrome opens that confirmed normal task route; if it is already open, Chrome reloads it to request fresh data through the website. Normal task navigation is intentionally allowed even when the original list is virtualized or no longer rendered.

The website's own JavaScript makes its usual authenticated request. `chrome.devtools.network.onRequestFinished` and `getContent()` capture its response. A short-lived Chrome session-storage ticket contains only request UUID, annotation ID, timestamp and safe status/error metadata. It correlates the exact GET, tab and ID, rejects requests that started before the ticket, and acknowledges success only after validated, redacted detail ingestion. No response body or authentication header is put in that ticket. The queue independently confirms the saved detail is fresh; an old cached review or a click is not a successful refresh.

Website mode enforces concurrency one, at least 1,500 ms between tasks after the preceding attempt settles, zero automatic retries and a 60-second wait for the captured response. Missing/closed DevTools, disabled capture, login/access navigation, missing response bodies, validation errors or native access refusals stop/pause collection with explicit errors. HTTP statuses and Retry-After come from the website's own response. A 401/403/429 is not retried or bypassed.

Pause/Cancel stop further navigation and remove the active ticket/listeners. An already-opened task can finish its normal request and passive capture can still save that result. Successful records and the chosen method persist; Resume skips saved successes. Capture remains armed until stopped in Sources. Keep the collection tab, target tab and DevTools open, not necessarily the initiating interface. This method collects only native JSON responses that the website actually produces; it does not guess score labels from page markup or establish listing completeness.

## Direct session API context

Open the extension popup on the signed-in LinkedIn AI Trainer tab, then choose Review Analytics. A user-initiated queue uses `chrome.scripting.executeScript` in that tab's **ISOLATED** world. The injected function is self-contained and checks the exact LinkedIn origin and `/ai-trainer` pathname before fetching.

The request is a relative GET with `mode: same-origin`, `credentials: same-origin`, `redirect: error`, an AbortSignal and only an Accept header. Chrome supplies session credentials according to its normal policies. The extension never reads cookies, including HttpOnly cookies, or recreates Authorization/CSRF headers. No extra required host permission was added: the existing `activeTab` and `scripting` permissions provide temporary user-granted tab access.

The generic Sources API connector remains extension-origin and is not used for this detail endpoint. Same-origin content-script requests and extension-origin requests have different authentication/origin behavior:

- [Chrome network-request guidance](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

This architecture does not guarantee LinkedIn will accept the request. Expired sessions, revoked tab access, navigation, platform checks or required unavailable headers can block it. HTTP 401/403 pauses the queue. Do not add copied headers, switch to credential extraction, or bypass a platform restriction. Capture detail responses generated by normal website navigation through DevTools, or import saved response JSON instead.

The user has reported a native website GET returning 200 while the direct collector receives 403. The native request includes site-managed CSRF protection that plain fetch does not generate; this is a possible difference, not a confirmed cause. A working website session is not proof that the direct collector request will be accepted. A 403 is an access refusal, not evidence of rate limiting or an expired login. Keep direct requests paused; explicitly use website-driven collection or the [manual native-response capture procedure](REVIEW_REQUEST_DEBUGGING.md#website-get-succeeds-but-collection-returns-403), without copying any credential headers.

## Queue and recovery

Direct API default concurrency is one, with 1,500 ms between request starts and two retries. The UI permits concurrency 1-3, pacing 500-30,000 ms and retries 0-3; website mode overrides these with the safer limits above. Direct starts share a pacer; requests have a 30-second timeout and streamed 10 MB limit. A Web Lock prevents simultaneous extension collectors, and the isolated direct-fetch context also guards duplicate in-flight IDs.

Transient network/timeout and HTTP 500/502/503/504 failures use bounded exponential backoff and Retry-After. Ordinary terminal failures are recorded per annotation and do not erase successes. HTTP 401/403/429 stops further queue work and aborts in-flight workers. A 429 cooldown is at least 60 seconds or the longer server Retry-After; long server waits pause for manual resume. Persisted cooldowns also block starting a fresh queue or refresh early. No automatic service polling occurs.

Each successful detail and each safe error is saved incrementally in IndexedDB. Pause and Cancel retain all saved results; **Resume saved queue** uses persisted IDs and skips saved successes. Refresh runs tag successful details with their run ID instead of trusting wall-clock timestamps, so remaining cached items are still refreshed after interruption. A new **Fetch Review Scores** skips all good cached details, including cached no-review results. **Refresh Existing Reviews** explicitly rechecks them and retains last good data if refresh fails.

The cache is the verified normalized detail stored with each annotation, not a second copy of raw responses or an in-memory-only flag. It has no TTL and is shared by direct API and website collection. Both queue initialization and the pre-attempt transaction check it; an item enriched by passive capture while waiting is skipped without another request or task navigation. Diagnostics' cache-skip count includes those late hits; queued is the original queue size. Ordinary list re-imports do not invalidate cached reviews.

Each active attempt carries its run identity. When a real detail is captured/imported during that attempt, ingestion marks it completed for that run before acknowledging the transport. If Pause arrives immediately after the save, Resume of an explicit refresh still skips that saved result instead of repeating it. A merge-only snapshot restore without verified details preserves the current good cache. Dataset deletion, snapshot replacement and extension-data removal are explicit destructive operations; snapshots provide a local backup. Resetting filters or closing the browser does not clear the cache.

The non-active collection tab owns execution, not the visible analytics page or suspendable MV3 service worker. You can navigate views or close the initiating popup/dashboard. The worker marks jobs interrupted when their runner closes or Chrome/extension restarts. Resume explicitly from Sources or Review Analytics; no background job starts automatically. Progress is read from IndexedDB in every interface, not component-local state. Chrome automatic discarding is disabled for the runner, but browser throttling/suspension can slow it. An already-delivered request cannot necessarily be undone. Pause/Cancel prevent further processing and attempt to abort direct fetches; native task requests may finish and be passively saved.

## What is stored

Only selected identity/state/project/iteration/pipeline IDs, epoch-millisecond timestamps, timing durations and these confirmed review fields are retained:

- `currentVersionReview.annotationScore`
- `currentVersionReview.status`
- `currentVersionReview.feedback`

The dedicated transport does not retain the full response, annotator profile, project/pipeline configuration or credentials. Feedback is conservatively redacted. Captured/imported detail payloads are normalized into a compact, redacted representation; existing list answers and titles survive enrichment.

IndexedDB schema 3 retains the schema-2 migration and repairs ambiguous legacy false-complete caches in records/snapshots. List `endedAt`/`taskId` or null/empty review defaults do not prove detail collection. A cache skip requires explicit verified provenance; real no-review detail responses remain cacheable. Some ambiguous old empty-review caches must be fetched once again. Snapshot schemas 1 and 2 can still be restored. JSON/JSONL exports retain normalized reviews; review CSV contains separate annotation/task IDs, full redacted feedback and collection status.

## Reading the results correctly

Quality scores are independent of Aesthetics, Functionality and Overall task answers. Confirmed reviewer fields cannot be mapped as task answers. Missing/invalid/nonfinite/numeric-string scores are excluded, never changed to zero. Finite zero is retained because a true valid score range has not yet been established. No 1-5 bounds, cross-scale conversion or categorical-to-numeric conversion is invented.

The average uses only available finite numeric annotation scores. Minimum, maximum, median, distributions and project/iteration/pipeline means use that same population. Approval rate is `APPROVED / reviewed with non-null status`; the denominator is shown. Unknown valid status strings are preserved.

The UI distinguishes unfetched, fetched without review, reviewed without numeric score, reviewed/scored, and fetch failure. A failed refresh can still show cached review data. Missing Reviews counts only fetched details without a review. Listing and detail completeness are independent: all loaded IDs enriched does not prove a global total.

The default Dashboard is the full saved-review analytics view, without collection controls. All saved records are included even when ineligible for live enrichment. Popup and side panel summarize saved review data. Dashboard and Review Analytics share review filters, metrics, charts, tables and filtered exports; task-answer filters remain separate in Results/Annotations. Dates refer to creation or confirmed SUBMITTED `endedAt`, not an invented review timestamp. Trends use ended date where available, otherwise creation date. Recent reviews means last observed, and repeated feedback patterns are exact case/whitespace-normalized matches, not inferred topics.

## Verification boundary

Unit tests exercise the confirmed response, queues, retry/access pauses, filtering, analytics, persistence, migration and exports. Chromium tests use the same self-contained isolated-world fetch function against an authenticated local fixture; they also test production transport refusal on the wrong origin, pre-start cancellation, review UI, CSV and restart persistence. The production transport remains fixed to LinkedIn; there is no localhost override.

**No real LinkedIn session or production endpoint request was executed during development.** Test success establishes the local implementation and fixture behavior, not permission to access or guaranteed compatibility with an actual account.

See [request debugging](REVIEW_REQUEST_DEBUGGING.md) for the fixed no-request defects, independent diagnostics, development-only single-ID action, precise Network contexts and the **NOT VERIFIED** real-session checklist.
