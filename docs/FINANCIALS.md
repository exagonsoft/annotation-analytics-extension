# Greenlight financials

## Financial truth and scope

Financials reads its own local IndexedDB cache. Opening Dashboard, Financials, popup or side panel does not query Greenlight. Native capture and DOM collection start only through explicit user actions.

The account-specific rules confirmed for this integration are:

- Currency is USD.
- Greenlight deliverable status `4` is Processed / paid.
- Every other deliverable status is treated as pending, as requested. This is not a universal Greenlight status enum.
- Actual deliverable amounts are authoritative. Rates are used only for explicitly confirmed estimates, not to reconstruct paid amounts.

Paid earnings and pending payments are summed in integer cents. Negative adjustments remain negative. Unsupported precision, invalid identities/dates, duplicate IDs within a response and response/request supplier or period mismatches are rejected before persistence.

Deliverables are keyed by supplier organization and deliverable ID. Repeated captures/imports update those records instead of adding them again. Newer `updatedAt` values are preserved against older imports. A subsequent response omitting a record does not delete a previously saved payment; the interface warns about this retained-history policy. Use explicit financial-cache deletion when removing old data.

Captured start/end periods describe the time responses obtained, not proven complete account/payment history. Missing weeks, stale data or deleted payments can change financial conclusions. Raw shifts and expenses are not included in deliverable totals.

## Authorized collection

1. Reload the updated unpacked extension and reopen Greenlight DevTools.
2. Open your signed-in `https://portal.greenlight.ai/dashboard` tab.
3. In the extension, select **Financials → Find Greenlight tab**.
4. Approve optional host access to `https://portal.greenlight.ai/*`. If several dashboards are open, select the intended tab.
5. Expand the website's Deliverables section, then choose **Collect rendered week & rates**.
6. Open DevTools on that Greenlight tab. Choose **Start financial capture** in Financials.
7. Reload Greenlight or navigate its weeks normally. Its own requests to `https://app.greenlight.ai/ui/suppliers/{supplier}/time?start=...&end=...` supply the JSON captured by the extension.
8. **Capture previous week** clicks only the observed previous-week chevron, once per user action. It waits up to 60 seconds for the expected week's native time response. There is no automatic history loop or retry.

The extension does not perform authenticated Greenlight API fetches itself. Native website code supplies its own authorization; the extension never reads, extracts, saves or replays bearer tokens, cookies, application globals or membership headers. It inspects response bodies through documented `chrome.devtools.network.onRequestFinished` and `getContent()` only when financial capture is enabled for that tab.

Native non-success HTTP responses, malformed JSON, unsupported data, unavailable bodies or storage failures stop capture and surface diagnostics. A refused request is not retried in another execution context. Both capture and import are limited to 20 MB.

**Network inspection:** the actual time GET is website-owned and appears in the Greenlight tab's Network panel, not as a service-worker fetch. Financials independently shows saved response count, last range, HTTP status and error. Keep the website and its DevTools open. Passive capture survives closing the extension interface; closing DevTools stops response-body access. Navigating away from Financials cancels an in-progress previous-week waiting action, but an already-started native request may still finish and be saved. Stop financial capture explicitly when finished.

If capture is unavailable, import a saved raw **time response body** with **Import saved Greenlight time JSON**. Do not import headers, credentials, a HAR, or normalized financial exports as though they were raw time responses.

## DOM rates and fallback

The DOM reader targets the supplied dashboard structure using CSS-module component-name prefixes, rather than full generated class hashes. It reads:

- The displayed week.
- Explicit deliverable engagement, date, amount, tag and payment-status text.
- Engagement title and its adjacent Pay Rate value/unit.

It does not collect manager names, avatar/profile information or the entire page HTML. It requires the number of rendered deliverables to match the displayed section count; collapsed or missing rows cause an explicit error. This still represents the displayed week only, not global history.

Rendered observations are stored separately by displayed week. When no native/imported time response exists, the latest rendered week provides a clearly labeled monetary fallback. DOM and API amounts are **never added together**. Once time responses are present, their deliverables become the ledger source; DOM remains useful for observed rates.

DOM rows do not expose task notes or stable payment IDs. Therefore they do not establish annotation counts, individual paid task identities, or cross-week deduplication. No amount/rate division is used to invent counts.

## Notes and correction accounting

Supported normal notes contain named batches with explicit `Att: N, Rev: M` counts. `Att` counts annotations; `Rev` counts review work separately. The optional tag prefix and observed `UI Berry 3R:` prefix are handled.

The observed correction form is:

```text
TAG|Correction for incorrect payment in batch Batch A (Paid: 6 Att, 0 Rev | Actual: 9 Att, 0 Rev)
```

That correction contributes **3 annotations**, not 9 or 15. Its actual payment amount is counted once as its own deliverable. Negative corrections are retained.

Unrecognized or partially parsed note formats keep the actual amount but exclude the entire ambiguous task count. The UI shows how many deliverables have unknown counts. Multi-batch monetary amounts are not arbitrarily split by counts; engagement/project-tag totals use the actual whole deliverables.

Batch notes do not identify which individual annotation IDs were paid. Financials reports aggregate paid/pending counts; it does not mark arbitrary records paid based on ordering or fuzzy text matching.

## Confirmed batch mappings and estimates

Financials automatically matches saved annotation `pipeline.name` to batch names parsed from deliverable notes. Whitespace and case are normalized; the observed standalone numeric segment immediately before `Set CODE - YYYY-MM-DD` is removed, but the Set code and batch date are preserved. For example, `Preference - 320 - Set AF - 2026-10-31` matches `Preference - Set AF - 2026-10-31`, never Set K or another date.

`pipelineStage.type` distinguishes `ATTEMPT` from `REVIEW`; explicit legacy stage/iteration labels provide a local fallback. Pipeline/project identities group cached tasks. Multiple annotation groups or supplier/engagement/tag scopes with the same name are reported as ambiguous, not automatically assigned. Corrections still contribute only their deltas. Unknown work types/notes or counts exceeding saved work exclude unaccounted counts. Matching does not infer rates, split payment amounts, prove complete history or mark individual IDs paid.

Reconciliation includes cached batches with **no saved deliverable**, not only batches already named in the ledger. Their known submitted attempt/review counts appear as completed work absent from the payment cache. Attempt and review uncertainty are evaluated separately so incomplete review coverage does not suppress a valid attempt count. Unknown notes can invalidate apparent ledger absence; missing metadata is shown as tasks awaiting reconciliation, not assumed unpaid.

The shared Dashboard/popup/side-panel summary separates actual pending Greenlight task counts from completed work absent from the ledger, and displays their combined pending-attempt **estimate**. Missing periods can overstate this estimate. Before any financial collection, monetary totals say **Not collected**, not `$0.00`. These automatically derived task counts do not infer an earnings rate or replace the confirmed-rate monetary estimate below.

Schema 6 persists the same normalized `batchKey` on annotations and financial batches. A minimal `annotationBatches` catalog retains only project/pipeline IDs, name/key, modification time and stage iteration IDs/types from `project.pipelines`. One captured or imported detail can repair unnamed cached peers by scoped pipeline identity or a unique iteration mapping. Conflicting metadata is excluded. Configuration, profiles and other annotators' task counts are not retained or used.

**Rebuild cached batch joins** in Financials repairs surviving local metadata, including snapshots, without task requests or changes to verified review timestamps. If both names and catalog are absent, import an original detail with its project pipeline catalog; ordinary collection still skips verified cached details.

Annotations offers **Batch join** and **Batch payment coverage** filters, including **Remaining to be paid**, plus cached-detail columns for coverage and batch remainder. For each work type:

```text
Remaining to be paid = unique saved submitted work − paid ledger counts
Unaccounted work = remaining to be paid − pending ledger counts
```

Remaining includes work already listed in pending deliverables. Partial batches show aggregate paid/remainder counts without guessing which individual annotation IDs were paid. Counts use the full saved dataset, even when filtering or exporting one record; uncertain reconciliation has no invented remainder. CSV includes join key, pipeline/work type, reviewer fields and payment coverage/counts; normalized JSON/JSONL includes batch coverage when exported from the interface.

### Observed same-batch earnings estimates

The cached financial summary and automatic batch table derive an observed rate from **positive paid deliverables attributable to one batch and one work type**. Attempts and reviews have separate rates. Positive correction payments use their positive task-count delta, not the full Actual count. Mixed-batch/mixed-work amounts and negative adjustments are not used as rate evidence; another batch's rate is never substituted. Eligible paid amounts/counts are summed to obtain a weighted same-batch average.

```text
Observed rate = attributable paid USD / attributable paid task count
Remaining earnings estimate = observed rate × (submitted − paid tasks)
Pending + unbilled estimate = actual pending ledger USD + observed rate × unaccounted tasks
```

The first estimate includes already-pending work; the second adds actual pending money only once. They are alternative views, not amounts to add together or to confirmed-rate estimates. Computation keeps the exact paid-cent/count ratio until rounding each batch/work-type total to cents; the displayed approximate unit rate is not multiplied after rounding. For example, `$10 / 3 paid tasks × 4 remaining` estimates `$13.33`, not `$13.32`.

Uncertain matches, missing rate evidence and missing batch metadata are explicitly excluded. Totals are known-rate subtotals, not guaranteed earnings; incomplete payment history and changed rates can overstate remaining money. Reads, filtering and browser restart require no task or financial requests. Normalized financial JSON includes observed-rate evidence/results based on the full saved caches even when exported deliverables are filtered.

### Optional confirmed-rate estimates

For a confirmed rate instead, map a Greenlight batch to an entire saved LinkedIn iteration (recommended) or project. Use one mapping level, one scope per batch and one batch per scope to avoid overlap. Mapping changes and removals are explicit.

For each mapping, confirm:

1. The annotation scope represents the same full batch named in Greenlight notes.
2. The entered USD rate applies to each submitted annotation.
3. Relevant payment periods have been captured.

A rendered `$21.67/project` rate is shown as evidence, **not automatically interpreted as a rate per annotation**. The user must confirm the applicable unit. Historical rate changes and reviewer rates are not inferred.

```text
Mapped submitted tasks = unique saved SUBMITTED annotation IDs in that scope
Estimated unbilled tasks = submitted − paid Att counts − pending Att counts
Estimated unbilled USD = estimated unbilled tasks × confirmed per-annotation rate
To be earned / received estimate = actual pending ledger USD + estimated unbilled USD
```

Pending task amounts already in the ledger are not multiplied again. Duplicate annotation records do not increase the submitted count. Unknown note counts, negative net counts or accounted tasks exceeding submitted records exclude that mapping's estimate rather than silently clamping it to zero.

Estimates use the entire saved financial/annotation cache, independently of ledger search/date filters. Missing payment weeks can overstate unpaid work. The interface identifies excluded mappings and estimate scope; it does not claim individual-task payment proof.

## Storage, export and deletion

IndexedDB schema 4 adds `payments`, `financialPeriods`, `financialDom` and `financialMappings` while preserving existing annotation records and review caches.
Schema 5 adds local batch metadata recovery. Schema 6 adds the minimal annotation batch catalog and shared indexed join keys; both retain the financial stores and verified review cache.

Financials has independent search, payment-date, payment-state, tag and supplier filters. Header Export and **Export financials** use these filters. CSV includes actual amounts, statuses, count uncertainty and redacted notes; JSON includes normalized ledger/period/DOM/mapping metadata; JSONL includes normalized payments. Financial exports are reports, not an implemented restore format.

Financial data remains separate from annotation snapshots. Annotation Clear current results/snapshot Replace do not erase it. **Clear financial cache** deletes only financial records, observations, periods and mappings. Settings' **Delete all local data** deletes both datasets. Stop capture before deleting. Free-text redaction is conservative, not guaranteed anonymization; review exports before sharing.

## Verification

Automated tests cover amount precision, supplier/range validation, update/dedup persistence, schema upgrades and local batch recovery, note/correction parsing, exact batch matching and ambiguous scopes, attempt/review classification, unknown counts, metadata export/snapshot/remap round-trips, cache reuse, explicit mappings, conflicting scopes, filtered CSV and the supplied DOM structure.

An isolated Chromium scenario uses the compiled production UI, real extension scripting, native website-origin requests and actual DevTools body capture against synthetic routed Greenlight pages. It checks tab discovery, rates, API/DOM separation, correction counts, mapping estimates, catalog-based peer recovery, annotation batch/remaining filters, full-batch counts in a single-record CSV, previous-week navigation, a native 403 stop, and offline Dashboard/popup/side-panel persistence after browser restart. Synthetic request markers are confined to tests; no real account token is used.

**Real signed-in Greenlight collection is NOT VERIFIED in development.**

Manual acceptance:

1. Follow the collection steps using your authorized account without sharing credentials.
2. Confirm rendered rate/unit and the selected week match the portal.
3. Capture a native time GET and verify its actual HTTP status and saved range.
4. Compare each saved amount/status to Greenlight; re-capture the same week and ensure no duplicate money.
5. Check regular `Att`/`Rev` counts and correction deltas against notes.
6. Confirm explicit batch mappings and applicable rate before trusting estimates.
7. Capture all relevant weeks; check scope warnings and ambiguous notes.
8. Restart Chrome without opening Greenlight and verify saved financial metrics remain.
9. Confirm native access failures stop capture rather than claim successful collection.
