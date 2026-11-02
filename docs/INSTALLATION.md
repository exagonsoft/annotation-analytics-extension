# Installation and operations

## Unpacked Chrome installation

```powershell
npm ci
npm run build
```

Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose **`dist`**, not the repository root. Pin the extension. Open its popup on the annotation website to grant temporary `activeTab` access and choose the website tab. The full dashboard and side panel use the same local dataset.

Open website DevTools separately for Network capture. The DevTools integration appears only after DevTools creates the extension context. After installing/reloading the extension, reopen DevTools if its panel is missing.

## Build and package

`npm run dev` watches and rebuilds. Reload the installed extension after relevant changes. `npm run build` type-checks and emits the installable distribution. `npm run package` builds and creates `artifacts\annotation-analytics-1.0.0.zip`.

The ZIP is an unpacked distribution for manual loading, not a signed CRX or Web Store submission. Extract it and load the extracted directory. No source map or remote runtime code is required.

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Non-sensitive settings and temporary capture flags |
| `activeTab` | User-selected tab identity and temporary DOM / same-origin review access |
| `scripting` | Explicitly inject DOM collection and isolated-world review requests |
| `sidePanel` | Optional companion interface |
| Optional HTTPS or localhost hosts | User-selected authorized API origin, requested only on collection |

There is no required all-sites host access, `cookies`, `debugger`, `webRequest`, history access, telemetry or external backend permission.

## Persistence

Records, snapshots and review-queue progress survive popup closure, service-worker suspension and browser restart in the same extension profile and extension ID. Review requests belong to the initiating review page; leaving it pauses execution, and restart requires explicit Resume. Removing the extension removes its data. Different unpacked extension locations can produce different IDs and separate storage; export JSON snapshots before moving directories or reinstalling.

Storage is subject to Chrome and device quotas. Snapshot payloads duplicate records. Keep backups as reviewed JSON exports; the extension does not back up to a remote service.

## Deletion

Stop DevTools and DOM capture and cancel API/review collection before deleting data. **Clear current results** removes records, source runs and review queues while retaining snapshots/settings. History deletes individual snapshots after confirmation. **Settings → Delete all local data** removes annotations, sources, review queues, snapshots, presets and settings after confirmation. Revoke optional API host access with the separate button.

## Troubleshooting

- **Popup reports no website:** open it from the annotation website, not `chrome://` or an extension page.
- **DOM access denied:** invoke the popup again on the target website; activeTab grants do not survive an origin change. Full navigation requires restarting DOM injection.
- **No recognized responses:** start capture before the requests finish; verify JSON MIME type, ID fields and annotation shape.
- **API returns 401/403 or HTML:** recheck the session and URL. Do not paste credentials. Use Network capture or saved-response import if policies prevent API access.
- **Unknown Overall:** inspect the actual JSON and configure a verified mapping. The task-list endpoint may not contain scores.
- **Review collection blocked:** reopen the popup on the signed-in LinkedIn AI Trainer tab and use Review Analytics. Honor 401/403/429 pauses and Retry-After. If the platform requires unsupported session checks, use DevTools/import, never copied credentials.
- **Missing review versus unknown:** only collected details without a review count as Missing Reviews; unfetched or failed records remain unknown. Reviewer quality is not an Overall task answer.
- **Partial total:** inspect source diagnostics, pagination and server scope. Do not use rendered DOM counts as global totals.
- **Missing Playwright browser:** `npx playwright install chromium`.
