# Network capture

## Supported mechanism

The MV3 `devtools_page` registers a panel named **Annotation Analytics**. While DevTools is open, it listens to `chrome.devtools.network.onRequestFinished`. If capture is armed for that inspected tab, successful JSON MIME-type responses are read through `request.getContent()`.

Base64 responses are decoded as UTF-8. Supported annotation envelopes are normalized and redacted before IndexedDB persistence. Source diagnostics show the detected array path, sanitized URL, timestamp, method, response status and reported total.

Neither the service worker nor `webRequest` is used to retrieve arbitrary Network response bodies. No debugger permission, request interception, main-world fetch monkey patch, remote script, credential scraping, headers or cookie access is used.

## Procedure

1. Open DevTools on your website.
2. Select Annotation Analytics (check the overflow menu).
3. Start capture. Reload or change task-list pages.
4. Confirm recognized source requests and loaded records.
5. Stop capture when finished. Closing DevTools also ends response-body access.

The popup can arm capture, but it does not open DevTools. If the extension was installed or reloaded while DevTools was already open, close and reopen DevTools.

## Limits

- Only requests completed after the listener and capture flag are active are collected.
- Unsupported, missing, evicted, oversized, malformed or non-JSON bodies cannot be recovered by this collector.
- A JSON response's presence does not prove evaluation scores are included.
- Unrelated JSON is ignored. Diagnostics are persisted for failures encountered while inspecting candidates.
- A 20 MB response-body limit protects memory.
- Passive capture is partial even when one captured response reports a total. Use the same scoped API collection or independently verify unique coverage.
- Navigate multiple pages manually to capture responses when the API connector cannot legitimately use the session.

## Review-detail fallback

If Fetch Review Scores is blocked, start DevTools capture and open annotations normally through the authorized website. Supported JSON responses from `/ai-trainer/api/frontendAnnotationTaskResults/{annotationId}` are normalized using `currentVersionReview.annotationScore`, status and feedback, independently of task-answer mappings. Details merge into existing LinkedIn rows by annotation ID; `taskId` is not that identity. A successful response without a review is still a successfully collected detail.

This captures only requests actually made by the website while capture is active. It does not enumerate IDs, open every annotation automatically or establish global listing coverage. Alternatively, import saved response JSON in Sources with its original LinkedIn response URL; no headers or HAR credentials are needed.

Official API: https://developer.chrome.com/docs/extensions/reference/api/devtools/network
