# Security and privacy

## Trust and access

This extension operates only with the user's existing authorization. It does not retrieve session-cookie values, bearer tokens, authentication headers or request bodies. API requests rely on the browser's normal session policy and explicitly requested host access.

DevTools uses the documented Network APIs, not interception or the debugger permission. DOM collection is explicitly injected into an active tab, in Chrome's isolated world. The worker accepts DOM ingestion messages only from extension content-script senders with a tab and URL and an enabled per-tab flag.

There is no telemetry, analytics endpoint, remote executable code, external script, automatic export or background upload. External task links open only when the user clicks them. All runtime libraries and assets are packaged locally.

## Untrusted data

- React renders external content as text; no `dangerouslySetInnerHTML` or HTML evaluation.
- Inspector content is read-only and escaped.
- Link URLs accept only HTTP/HTTPS, with credentials, query and fragment removed.
- Prototype-related field paths are rejected.
- Zod validates object boundaries; domain guards validate IDs, scores, dates and pagination.
- Raw data is redacted before IndexedDB persistence, including nested serialized JSON.
- Credential/contact-like keys, bearer/JWT-like strings and recognizable email strings are conservatively redacted.
- Source URLs never include username/password, query parameters or fragments.
- Export routines redact again; CSV cells starting with dangerous spreadsheet characters, including leading whitespace, receive an apostrophe prefix.

Redaction is best effort, not anonymization. Free text and route paths may contain identifying or sensitive information that cannot be reliably classified. Conservative key matching can also remove legitimate fields; such fields cannot be recovered from stored data. Inspect before sharing. Never use exports as a secure unredacted network archive.

## API safety

HTTPS is required except localhost fixtures. Credential-bearing URL fields are rejected. Requests are GET-only with no caller-supplied authorization header, explicit `credentials: include`, and `redirect: error`. Next links must stay on the configured origin. Permissions are requested only after a user action and may be revoked.

Requests have page/rate/retry limits, bounded streamed response bodies and cancellation. Retry-After is respected; excessive waits stop rather than trigger early retries. Partial data is retained and failures surfaced. The connector does not proxy requests or bypass a server's authentication or access-control decisions.

## LinkedIn review boundary

Per-annotation review collection uses the existing temporary `activeTab` grant and `scripting` in Chrome's isolated world, not a main-world interceptor. Production transport is fixed to `https://www.linkedin.com`; the injected function verifies the origin/path and uses a relative same-origin GET. Only the browser-managed authorized session is used, with no custom credential/CSRF headers and no cookie API.

Only IDs from the persisted authorized listing are requested. Neither numeric enumeration nor `nextResultId` traversal is implemented. A Web Lock, duplicate-ID guard, bounded queue, conservative pacing, retry limits, timeout and body-size bound constrain execution. HTTP 401/403/429 pauses work rather than circumventing access controls. Retry-After cooldowns persist across new queues, refreshes and restart.

The dedicated transport returns only selected fields; annotator profiles and project/pipeline configuration are not retained. Review status/feedback and all persistence/export paths pass redaction. Successful details survive refresh failure. Error messages do not include raw exception text, headers or response bodies. Free-text redaction is still best effort; inspect feedback before export.

The verified browser fixture uses synthetic session material and an isolated profile. No real LinkedIn credentials or session requests were used in development. See [review collection](REVIEW_COLLECTION.md) for precise supported-context and fallback limitations.

## Local retention

Chrome extension-origin IndexedDB contains annotations, redacted raw payloads and snapshots. Chrome Storage Local contains mappings, presets and non-sensitive endpoint configuration; Session storage contains capture flags. Data is not application-level encrypted and is accessible to someone with access to the browser profile/device.

Stop collectors before deletion. Clear-current preserves snapshots; full deletion removes stored data and settings. Optional host permissions have a separate revocation control. Browser removal also removes extension storage.

## Development dependencies

Use the lockfile with `npm ci`; run `npm audit`, tests, lint and build before release. The minimatch override pins a patched compatible named-export API for the lint toolchain. Build/test dependencies are not shipped as remotely fetched runtime code.

## Reporting

Do not attach credentials, unredacted HAR files or personal annotation content to bug reports. Provide a minimal anonymized response shape and the safe source diagnostic instead. No production platform integration or privacy guarantee should be inferred solely from fixture tests.

## Initial review

A read-only source security review of the extension's permissions, networking, data boundaries, redaction, exports, messaging and rendering identified no high-confidence exploitable vulnerabilities. This is not a guarantee of absence; the residual limitations above and real-platform validation still apply.
