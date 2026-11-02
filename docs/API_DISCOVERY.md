# Authorized API discovery

## Establish the endpoint from evidence

Use your platform's Network tab while performing a task-list action. Inspect the JSON response, request method, list envelope, filters, pagination metadata and total. Configure only URLs you are authorized to access.

The connector accepts HTTPS endpoints and localhost HTTP fixtures. It uses GET with `credentials: include`, an Accept header, a cancellation signal, no custom credentials, and no redirect following. It requests optional host access only after a user click. Chrome may represent host permissions across ports; review the browser prompt.

Do not paste tokens, credentials, cookie strings, copied fetch snippets, signed query parameters, or request headers. Sensitive parameter names and recognizable bearer/JWT values are rejected. Endpoint query filters are retained locally only if non-sensitive.

## Supported pagination contracts

| Response evidence | Request behavior |
|---|---|
| `next`, `nextUrl`, or `links.next` URL | Resolve same-origin link and preserve omitted existing filters |
| Explicit null next link | Terminal page |
| `nextCursor` | Set existing `after` parameter, otherwise `cursor` |
| `pageInfo.endCursor` with `hasNextPage: true` | Same cursor behavior |
| `hasNextPage: false`, `hasMore: false`, null next cursor | Terminal page |
| Numeric `page`/`currentPage` and `totalPages`/`pageCount`, existing `page` query | Increment page number |
| Numeric offset/limit/total and existing `offset` query | Increment offset |

Metadata is recognized at root, `pagination`, `meta`, `meta.pagination`, `data.pagination`, and the detected annotation-list parent, including connection `pageInfo`.

Cursor parameter conventions are limited to `after` and `cursor`; put the correct existing parameter in your first URL. Page-number collection is one-based. APIs with other parameter names, POST bodies, custom cursor encodings or mixed/ambiguous list contracts need an adapter or manual capture. The collector does not invent pagination by requesting arbitrary sequential pages until empty.

Existing non-pagination query filters are retained. The API must provide consistent next-page links. A repeated URL ends the run with a loop diagnostic. Total values must be nonnegative safe integers.

## Rate limits and failures

The default inter-page delay is 500 ms, minimum 100 ms. Retryable statuses are 429, 502, 503 and 504, with at most three attempts. Retry-After seconds or dates are honored up to 30 seconds; longer server delays stop collection rather than retrying prematurely. Transport errors and non-retryable statuses stop with feedback. Redirects and cross-origin next links are refused.

The page cap defaults to 100 and cannot exceed 1,000. Response bodies are streamed with a 20 MB bound. Cancel stops further requests and keeps completed pages. Leaving Sources cancels that context's run. A later failure marks the run partial.

## Separate result endpoints

If evaluation results are absent from task-list JSON:

1. Load annotations normally.
2. Discover the actual result endpoint and verify a real relationship, such as `result.annotationId` matching `annotation.id`, or a task identity present in both.
3. In Sources, expand **Related result endpoint**, enable joining, and configure the result array path, result identity path, and matching raw annotation path.
4. Fetch the result endpoint through the same authorized workflow.
5. Inspect `relatedResult` in a matched annotation, then map its real score paths in Settings.

Joins are same-origin only. Unmatched records and ambiguous annotation IDs are diagnosed, not attached arbitrarily. A task-level join may update multiple annotation attempts when the configured task identity is explicitly shared; select task-level scoring with the corresponding identity path so analytics counts that task once. Related-source completeness refers to fetching result pages, not annotation-population coverage.

Cross-origin result endpoints, unverified joins, POST-only requests or inaccessible session policies require another explicitly supported adapter or manual import of combined annotation objects. No relationship is guessed from titles.

## Browser session limitations

Host permission permits documented extension requests; it does not log the user in, transfer tokens, bypass authorization or guarantee cookies are sent. SameSite, partitioned cookies, SSO, CSRF, request-origin checks, server policies and expired sessions can prevent access. A login HTML response is not a successful collection. Use DevTools capture or saved JSON when the authorized API cannot be accessed legitimately.

## LinkedIn per-annotation reviews

The confirmed detail endpoint is `GET https://www.linkedin.com/ai-trainer/api/frontendAnnotationTaskResults/{annotationId}`. Use **Review Analytics → Fetch Review Scores**, not the generic extension-origin connector or a task-ID join. The dedicated collector runs a relative same-origin GET in the selected authorized website tab, with no supplied credential headers. It uses only IDs already discovered from the listing and never follows `nextResultId`.

Its queue defaults to one request at a time with 1,500 ms pacing. Unlike the generic list connector, it pauses immediately on 401/403/429; persisted Retry-After/cooldown applies to resume and new refreshes. Successful details persist incrementally and survive interruption. See [review collection](REVIEW_COLLECTION.md).

The detail route and response fields were supplied and are fixture-tested. No production listing endpoint, real LinkedIn session request, or production pagination contract was tested.
