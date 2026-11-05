# Data model

See `src\core\model.ts` for the canonical TypeScript interfaces.

## Annotation identity

An annotation normally has a stable key serialized as `[origin, projectId, id]`. For the confirmed LinkedIn contract, annotation IDs are project-independent: the key is `[https://www.linkedin.com, null, id]`, and `taskId` is separate metadata, never request identity. The request path, task title and score are not identity. Separate annotation/attempt IDs remain separate even when titles match. Different origins do not collide.

If a DOM row lacks a project but a richer network record from the same origin and ID exists, the DOM summary is not added as another annotation. A later network record promotes a project-unknown DOM row. Imports with no supplied response URL use an `import` namespace, because assuming their platform origin could merge unrelated records.

IDs must be nonempty strings or numbers. Recognized records have an ID plus annotation-specific evidence such as `type: ANNOTATION`, `annotationData`, or state plus task fields. Arbitrary objects with only an ID are not annotation records.

## Normalized record

Metadata includes ID, project, iteration, template, type, state, created/claimed/modified timestamps, title, task/attempt URLs, original parsed input and annotation data, latest result, pipeline and iteration objects, and optional normalized `batchKey`.

- Unknown properties are `null`, not invented defaults.
- Valid timestamps, including numeric epoch milliseconds, become ISO UTC strings in annotation metadata.
- Serialized JSON strings are recursively decoded when valid.
- Malformed serialized input/annotation fields are retained with parsing warnings.
- All payloads pass conservative redaction before persistence.
- `rawPayload` is redacted debugging data, not an unredacted network archive.
- `source` is request metadata at ingestion time. The sources store holds final run progress/completeness.

Recognized envelopes include individual annotations, arrays, nested arrays (for example `data.tasks`), and GraphQL-style `edges[].node`. Search depth is bounded. An envelope with multiple independent annotation arrays selects the one with the most recognized records; collect separate endpoints rather than assuming unrelated lists are one population.

## Scores

Each dimension has `value`, `scale`, `scoreSource` (verified dot path), `scoringStatus`, `level`, and optional task `entityId`.

- `missing`: no mapping, field absent, null, or empty.
- `invalid`: wrong type, out of bounds, unsupported configured category, invalid scale, or missing task identity.
- `verified`: the explicitly mapped field passed its configured validation.

Mappings never treat annotation state, result state, or title numbers as scores automatically. Score configuration itself is not proof that the platform uses that field as an evaluation result; the user must verify it in the source JSON.

## Reviewer quality

`AnnotationRecord.detail` is separate from task-answer `scores`. It tracks pending/fetching/complete/failed status, explicit verified provenance, successful run identity, attempts, bounded safe errors, fetched/attempt timestamps, collection method and nullable `AnnotationDetail`. List existence/timing and null/empty review defaults do not establish enrichment.

`AnnotationDetail` retains numeric annotation/task/project/iteration/pipeline IDs, allowlisted `pipelineName` and `pipelineStageType`, state, epoch-millisecond timing fields and `AnnotationReview` (`annotationScore`, status, feedback, reviewed). Batch metadata is optional for older caches. The confirmed review paths are under `currentVersionReview`; no score range or status enumeration is assumed. These paths are reserved for Review Analytics rather than task-answer mappings.

No fetched detail is different from fetched/no review, reviewed/no numeric score, reviewed/scored, or failed fetch. Failed refreshes preserve good cached detail. A current review object establishes reviewed presence; only finite numbers establish a score. Profiles and large project/pipeline configuration are not retained by the dedicated detail collector.

The supplied LinkedIn detail responses contain only `annotationData.ATTEMPT_URL`; their serialized template defines that URL control, not Aesthetics/Functionality/Overall answer fields. The numeric `currentVersionReview.annotationScore` is reviewer quality. The explorer defaults to cached reviewer score/status, batch, work type, task identity and submitted timestamp when no mapped task answers exist. Explicit column choices persist; the task-answer preset retains separate real mappings and labels missing mappings/answers rather than substituting reviewer scores.

## Sources and completeness

A source run records its UUID, method, sanitized URL, timestamp, HTTP method/status when applicable, reported scoped total, pages, completed HTTP requests, received records, unique run records, stored overlaps/duplicates, terminal failures, diagnostics and completeness.

`complete` means the supported API run reached an explicit terminal condition or reached a reported count without an inconsistent shortfall. `partial` means completeness is unknown, capture was passive, import/DOM only, a safety limit/cancellation occurred, or a later page failed. `failed` means no page was successfully ingested.

Source totals are not additive. Filters in the dashboard operate on loaded records; they do not retroactively change the meaning of server-reported totals.

## Storage and snapshots

- IndexedDB schema 6: normalized records, source runs, snapshots and resumable `reviewRuns`, plus separate financial payments, periods, DOM observations and batch mappings. `annotationBatches` stores a minimal project-scoped pipeline/stage catalog. The upgrade repairs surviving local batch metadata and persists shared annotation/payment keys without network requests or invalidating verified details.
- Chrome Storage Local: score mappings, non-sensitive endpoint configuration, presets, column visibility, rate/page settings.
- Chrome Storage Session: per-tab capture flags and the explicitly selected website tab.

Snapshots contain schema version, name, creation time, records, sources and mappings. Replace/merge reparses records using current mappings. The stored mapping is retained for audit and comparison, not silently installed as the current scoring configuration.

New snapshots use schema 2; schema 1 remains restorable. The database migration recovers task IDs, epoch timestamps and already captured review details, and redacts legacy profile fields. Normalized review exports are validated on import; raw detail responses are also supported.

Schema 3 conservatively requeues ambiguous old empty-review caches without removing annotation rows. Real successful detail requests and meaningful confirmed reviews remain cached. Failed queues are partial/paused rather than represented as successful collection.

## Financial data

Schema 4 retains the annotation stores and adds `payments` keyed by supplier organization/deliverable ID, `financialPeriods` keyed by supplier/start/end, `financialDom` keyed by rendered week, and `financialMappings` keyed by annotation grouping/scope.

Payment records retain selected amount/date/status, engagement/tag, redacted notes and parsed batch counts. Amounts use exact USD cents. User identity fields, creator/updater identity, IP metadata, documents, profiles and authentication data are not retained. Status 4 is paid and every other status pending for this explicitly confirmed account rule.

Corrections contribute count deltas; ambiguous notes do not invent counts. Financial DOM observations remain separate from API ledger totals. Explicit scope mappings support aggregate unbilled estimates, not individual-task paid labels. Financial periods do not establish complete account history.

`batchKey` uses one shared whitespace/case/separator normalization and removes only the observed separate numeric segment before Set/date. `annotationBatches` is keyed by `[projectId, pipelineId]`, with names, modification timestamps and stage iteration IDs/types; no project configuration or personal data is retained. A unique scoped catalog match repairs cached metadata. Contradictory names or iteration mappings do not establish identity.

Annotation payment coverage is derived from both full caches, not persisted as an individual payment assignment. Paid/pending/partial/unresolved/not-submitted states support explorer filters; remaining is submitted work minus paid counts, independently for attempts and reviews. Partial-batch rows repeat aggregate coverage. Annotation exports include this report metadata, while normalized imports revalidate task/detail metadata and recalculate financial coverage from the local ledger.

Observed earnings are derived cache-only per matched batch/work type from attributable positive paid deliverable cents/counts. The evidence numerator/denominator and remaining/unaccounted totals accompany financial JSON reports. Integer-ratio arithmetic rounds the final projection to cents, not the unit rate. Mixed payments do not establish a rate; unavailable estimates and missing metadata remain excluded. Actual ledger money, observed-rate estimates and optional confirmed-rate estimates are not combined indiscriminately.

Financial exports and deletion are independent from annotation snapshots. See [Financials](FINANCIALS.md).
