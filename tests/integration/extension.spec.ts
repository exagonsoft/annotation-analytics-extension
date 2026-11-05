import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from '../fixtures';
import { reviewFixture } from '../review-fixtures';
import { abortAnnotationDetailInPage, fetchAnnotationDetailInPage } from '../../src/collectors/detail-session';
import { financeFixture, financeUrl, greenlightMarkup } from '../finance-fixtures';

let server: Server;
let origin: string;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profile: string;
let fixtureExtension: string;
const detailRequests: number[] = [];
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/ai-trainer/api/frontendAnnotationTaskResults/')) {
      if (!request.headers.cookie?.includes('fixture_session=authorized')) {
        response.writeHead(401, { 'Content-Type': 'application/json' }); response.end('{"error":"Fixture login required"}'); return;
      }
      const id = Number(url.pathname.split('/').at(-1));
      detailRequests.push(id);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(reviewFixture(id, { pipeline: { id: 7001, name: 'Session fixture batch', configuration: 'not-retained' },
        pipelineStage: { id: 7101, type: 'ATTEMPT', configuration: 'not-retained' },
        project: { id: 989007, projectConfig: 'not-retained', pipelines: [
          { id: 7001, name: 'Session fixture batch', stages: [{ iterationId: 3188053, type: 'ATTEMPT', reviewConfig: 'not-retained' }] },
        ] } })));
    } else if (url.pathname === '/api/tasks') {
      if (!request.headers.cookie?.includes('fixture_session=authorized')) {
        response.writeHead(401, { 'Content-Type': 'application/json' }); response.end('{"error":"Fixture login required"}'); return;
      }
      const page = Number(url.searchParams.get('page') ?? 1);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        tasks: page === 1 ? [fixture('live-1'), fixture('live-2')] : [fixture('live-2'), fixture('live-3', { state: 'IN_PROGRESS', annotationData: null })],
        pagination: { page, totalPages: 2 }, total: 3,
      }));
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Set-Cookie', 'fixture_session=authorized; Path=/; HttpOnly; SameSite=Lax');
      response.end('<!doctype html><html lang="en"><title>Authorized fixture</title><body><h1>Annotation fixture</h1><table><thead><tr><th>Annotation ID</th><th>Title</th><th>Status</th><th>Overall</th></tr></thead><tbody><tr data-annotation-id="dom-live-1"><td>dom-live-1</td><td>Rendered annotation</td><td>SUBMITTED</td><td>4</td></tr></tbody></table></body></html>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server failed to start.');
  origin = `http://127.0.0.1:${address.port}`;
  profile = await mkdtemp(join(tmpdir(), 'annotation-analytics-test-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--auto-open-devtools-for-tabs'],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});
test.afterAll(async () => {
  await context?.close();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('Chrome accepts MV3 and all extension surfaces render without runtime errors', async () => {
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.devtools_page).toBe('devtools.html');
  expect(manifest.permissions).not.toContain('webRequest');
  for (const size of [16, 32, 48, 128]) {
    const path = manifest.icons?.[size];
    expect(path).toBe(`icons/icon${size}.png`);
    const png = await readFile(join(resolve('dist'), path!));
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
  for (const [file, text] of [['dashboard.html', 'Your annotation overview'], ['popup.html', 'Open analytics dashboard'], ['sidepanel.html', 'Recent annotations'], ['panel.html', 'Network capture']] as const) {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/${file}`);
    await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
  }
  await context.close();
  // Headless Chromium cannot accept native host-permission prompts. Pregrant the
  // local fixture in a test-only manifest; shipped code and manifest stay intact.
  fixtureExtension = join(profile, 'fixture-extension');
  await cp(resolve('dist'), fixtureExtension, { recursive: true });
  const manifestPath = join(fixtureExtension, 'manifest.json');
  const fixtureManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  fixtureManifest.host_permissions = [`${origin}/*`, 'https://www.linkedin.com/*', 'https://portal.greenlight.ai/*'];
  await writeFile(manifestPath, JSON.stringify(fixtureManifest));
  await writeFile(join(fixtureExtension, 'review-test-bridge.js'), `export ${fetchAnnotationDetailInPage.toString()}\nexport ${abortAnnotationDetailInPage.toString()}`);
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--disable-extensions-except=${fixtureExtension}`, `--load-extension=${fixtureExtension}`, '--auto-open-devtools-for-tabs'],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});

test('real DevTools integration registers its panel and reads supported network bodies', async () => {
  const target = await context.newPage();
  await target.goto(origin);
  const tabId = await worker.evaluate(async origin => {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    const id = tabs[0]?.id;
    if (!id) throw new Error('Fixture tab missing.');
    await chrome.storage.session.set({ [`capture:${id}`]: true });
    return id;
  }, origin);
  await expect.poll(async () => worker.evaluate(async id => (await chrome.storage.session.get(`devtools:${id}`))[`devtools:${id}`], tabId), { timeout: 20_000 }).toBe(true);
  await target.evaluate(async () => { await (await fetch('/api/tasks?page=1')).json(); });
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await expect(dashboard.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('2');
  await dashboard.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(dashboard.getByText('devtools', { exact: true })).toBeVisible();
  await expect(dashboard.getByText('Detected records at tasks.', { exact: false })).toBeVisible();
  await worker.evaluate(async id => { await chrome.storage.session.set({ [`capture:${id}`]: false }); }, tabId);
  await dashboard.getByRole('button', { name: 'Dashboard', exact: true }).click();
  dashboard.once('dialog', dialog => dialog.accept());
  await dashboard.getByRole('button', { name: 'Clear current results' }).click();
  await expect(dashboard.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('0');
  await dashboard.close(); await target.close();
});

test('real fixture API pagination, mappings, filters, exports, snapshots and restart persistence', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Endpoint, including existing filters and first-page query').fill(`${origin}/api/tasks?page=1&project=one`);
  await page.getByRole('button', { name: 'Fetch all available pages / refresh' }).click();
  await expect(page.getByText('Collection ended with a verified terminal condition.', { exact: false })).toBeVisible();
  await expect(page.getByText('4 received · 2 pages · 1 duplicates', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const mapping = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Overall mapping' }) });
  await mapping.getByLabel('Verified JSON path (dot notation)').fill('annotationData.evaluation.overall');
  await mapping.getByLabel('Scale name').fill('rubric-v1');
  await mapping.getByLabel('Minimum', { exact: true }).fill('1');
  await mapping.getByLabel('Maximum', { exact: true }).fill('5');
  await mapping.getByRole('button', { name: 'Apply to all records' }).click();
  await expect(page.getByText('Mappings saved and all loaded records recalculated.')).toBeVisible();
  await page.getByRole('button', { name: 'Results', exact: true }).click();
  await expect(page.locator('.metric').filter({ hasText: 'Average Overall' }).locator('strong')).toHaveText('4.00');
  await expect(page.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('3');
  await page.getByLabel('Search annotations').fill('live-3');
  await expect(page.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('1');
  await expect(page.getByText('Average Overall', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No mapped task-answer scores', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page.getByRole('button', { name: 'Annotations', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Annotations' })).toBeVisible();
  await page.getByRole('cell', { name: 'live-1', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Close dialog').click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  expect((await download).suggestedFilename()).toBe('annotations-filtered.csv');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByLabel('Snapshot name').fill('Fixture baseline');
  await page.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fixture baseline' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/history.png', fullPage: true });
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await page.screenshot({ path: 'artifacts/dashboard.png', fullPage: true });
  await page.close();
  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${fixtureExtension}`, `--load-extension=${fixtureExtension}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/dashboard.html?view=results`);
  await expect(reopened.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('3');
  await expect(reopened.locator('.metric').filter({ hasText: 'Average Overall' }).locator('strong')).toHaveText('4.00');
  await reopened.close();
});

test('DOM collector reads explicit rendered rows and observes dynamic additions', async () => {
  const target = await context.newPage();
  await target.goto(origin);
  const id = await worker.evaluate(async origin => {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    const id = tabs[0]?.id;
    if (!id) throw new Error('Fixture tab not found.');
    await chrome.storage.session.set({ [`dom:${id}`]: true });
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['assets/dom.js'] });
    return id;
  }, origin);
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await expect(dashboard.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('4');
  await target.evaluate(() => {
    const row = document.querySelector('tbody tr')!.cloneNode(true) as Element;
    row.setAttribute('data-annotation-id', 'dom-live-2');
    row.querySelector('td')!.textContent = 'dom-live-2';
    document.querySelector('tbody')!.append(row);
  });
  await expect(dashboard.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('5');
  await worker.evaluate(async id => { await chrome.storage.session.set({ [`dom:${id}`]: false }); await chrome.tabs.sendMessage(id, { type: 'STOP_DOM' }); }, id);
  await dashboard.close(); await target.close();
});

test('same-origin isolated-world detail fetch, review UI, CSV, origin refusal and restart cache', async () => {
  const target = await context.newPage();
  await target.goto(`${origin}/ai-trainer`);
  const tabId = await worker.evaluate(async origin => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/ai-trainer` });
    if (!tab?.id) throw new Error('Review fixture tab not found.');
    await chrome.storage.session.set({ targetTab: tab.id });
    return tab.id;
  }, origin);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html?tab=${tabId}`);
  const { result, cancelled } = await page.evaluate(async ({ tabId, origin }) => {
    const bridge: Pick<typeof import('../../src/collectors/detail-session'), 'fetchAnnotationDetailInPage' | 'abortAnnotationDetailInPage'> = await import(chrome.runtime.getURL('review-test-bridge.js'));
    const [fetched] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: bridge.fetchAnnotationDetailInPage,
      args: [{ id: 7901345, requestId: 'fixture-review-request', expectedOrigin: origin }],
    });
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: bridge.abortAnnotationDetailInPage, args: ['cancel-before-start'],
    });
    const [cancelled] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: bridge.fetchAnnotationDetailInPage,
      args: [{ id: 7901346, requestId: 'cancel-before-start', expectedOrigin: origin }],
    });
    return { result: fetched!.result!, cancelled: cancelled!.result! };
  }, { tabId, origin });
  expect(result.kind).toBe('response');
  if (result.kind !== 'response') throw new Error('Fixture session fetch did not return a response.');
  expect(result.status).toBe(200);
  expect(result.payload).toMatchObject({ currentVersionReview: { annotationScore: 4 }, pipeline: { id: 7001, name: 'Session fixture batch' }, pipelineStage: { id: 7101, type: 'ATTEMPT' } });
  expect(result.payload).not.toHaveProperty('annotatorProfile');
  expect(result.payload).not.toHaveProperty('pipeline.configuration');
  expect(result.payload).not.toHaveProperty('pipelineStage.configuration');
  expect(result.payload).toMatchObject({ project: { id: 989007, pipelines: [{ id: 7001, name: 'Session fixture batch',
    stages: [{ iterationId: 3188053, type: 'ATTEMPT' }] }] } });
  expect(result.payload).not.toHaveProperty('project.projectConfig');
  expect(result.payload).not.toHaveProperty('project.pipelines.0.stages.0.reviewConfig');
  expect(detailRequests).toEqual([7901345]);
  expect(cancelled).toEqual({ kind: 'error', reason: 'aborted' });
  expect(detailRequests).toEqual([7901345]);
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Original response URL (optional)').fill('https://www.linkedin.com/ai-trainer/api/list');
  await page.locator('input[type=file]').setInputFiles({ name: 'review-list.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    records: [7901345, 7901346].map(id => fixture(String(id), { taskId: 4010128, projectId: 989007 })),
  })) });
  await expect(page.getByText('Imported 2 new unique annotations.', { exact: false })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'review-detail.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(result.payload)) });
  await expect(page.getByText('Imported 0 new unique annotations.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Results', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reviewer scores', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('4.00');
  await expect(page.getByText('Average Overall', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Task answers', exact: true }).click();
  await expect(page.locator('.metric').filter({ hasText: 'Average Overall' }).locator('strong')).toHaveText('4.00');
  await page.getByRole('button', { name: 'Review Analytics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review Analytics', exact: true })).toBeVisible();
  await expect(page.locator('.metric').filter({ hasText: 'Details Collected' }).locator('strong')).toHaveText('1');
  await expect(page.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('4.00');
  await expect(page.locator('.metric').filter({ hasText: 'Missing Reviews' }).locator('strong')).toHaveText('0');
  await page.locator('summary').filter({ hasText: 'Review filters ·' }).click();
  await page.getByLabel('Review status', { exact: true }).selectOption('APPROVED');
  await expect(page.locator('.metric').filter({ hasText: 'Total Annotations' }).locator('strong')).toHaveText('1');
  await page.locator('.review-table').getByRole('button', { name: '7901345', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Synthetic reviewer feedback for a test annotation.');
  await page.getByLabel('Close dialog').click();
  const exporting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review CSV' }).click();
  const file = await exporting;
  expect(await readFile((await file.path())!, 'utf8')).toContain('APPROVED');
  await page.getByRole('button', { name: 'Clear review filters' }).click();
  await page.getByLabel('Collection method').selectOption('session');
  await page.getByRole('button', { name: 'Fetch Review Scores', exact: true }).click();
  await expect(page.getByText('Paused: The selected tab is not on', { exact: false })).toBeVisible();
  await expect(page.locator('.metric').filter({ hasText: 'Fetch Failures' }).locator('strong')).toHaveText('1');
  expect(detailRequests).toEqual([7901345]);
  await page.screenshot({ path: 'artifacts/review-analytics.png', fullPage: true });
  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${fixtureExtension}`, `--load-extension=${fixtureExtension}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/dashboard.html?view=reviews`);
  await expect(reopened.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('4.00');
  await expect(reopened.locator('.metric').filter({ hasText: 'Details Collected' }).locator('strong')).toHaveText('1');
  await expect(reopened.locator('.metric').filter({ hasText: 'Fetch Failures' }).locator('strong')).toHaveText('1');
  await reopened.close();
});

test('built production UI starts real browser fetches for list IDs instead of treating list defaults as cache (routed fixture, NOT real LinkedIn)', async () => {
  const requested: number[] = [];
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  await context.route('https://www.linkedin.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/ai-trainer/api/frontendAnnotationTaskResults/')) {
      expect(route.request().method()).toBe('GET');
      const headers = await route.request().allHeaders();
      expect(headers.cookie).toContain('aa_fixture_session=authorized');
      expect(headers.authorization).toBeUndefined();
      const id = Number(url.pathname.split('/').at(-1));
      requested.push(id);
      if (id === 7000102) await responseGate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(reviewFixture(id)) });
    } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic AI Trainer fixture - not LinkedIn</title><p>Isolated test only</p>' });
  });
  await context.addCookies([{ name: 'aa_fixture_session', value: 'authorized', domain: 'www.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const target = await context.newPage();
  await target.goto('https://www.linkedin.com/ai-trainer/completed');
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/ai-trainer/*' });
    if (!tab?.id) throw new Error('Synthetic AI Trainer tab missing.');
    await chrome.storage.session.set({ targetTab: tab.id });
    return tab.id;
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html?tab=${tabId}`);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear current results' }).click();
  await expect(page.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('0');
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Original response URL (optional)').fill('https://www.linkedin.com/ai-trainer/api/test-annotation-list');
  await page.locator('input[type=file]').setInputFiles({
    name: 'completed-list-defaults.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      records: [7000101, 7000102].map(id => reviewFixture(id, { currentVersionReview: null })),
    })),
  });
  await expect(page.getByText('Imported 2 new unique annotations.', { exact: false })).toBeVisible();
  // The development control, when built, still uses the production collector and never mocks its transport.
  await page.getByRole('button', { name: 'Review Analytics', exact: true }).click();
  await expect(page.locator('.metric').filter({ hasText: 'Details Collected' }).locator('strong')).toHaveText('0');
  const diagnostic = page.getByRole('button', { name: 'Test Annotation Detail Request', exact: true });
  if (process.env.ANNOTATION_DIAGNOSTIC_BUILD === '1') {
    await expect(diagnostic).toBeVisible();
    await page.getByLabel('Discovered annotation ID', { exact: true }).fill('7000101');
    await diagnostic.click();
    await expect(page.getByText('Saved annotation 7000101', { exact: false })).toBeVisible();
    expect(requested).toEqual([7000101]);
  } else await expect(diagnostic).toHaveCount(0);
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Collection method').selectOption('session');
  const opening = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Fetch Review Scores', exact: true }).click();
  const runner = await opening;
  await expect(runner).toHaveURL(/collection\.html\?job=/);
  await page.getByRole('button', { name: 'Review Analytics', exact: true }).click();
  const reviews = page;
  await expect(reviews.getByLabel('Collection method')).toHaveValue('session');
  const diagnostics = reviews.getByRole('region', { name: 'Detail collection diagnostics' });
  try {
    await expect.poll(() => requested.includes(7000102)).toBe(true);
    await expect(diagnostics.locator('dt').filter({ hasText: /^Requests started$/ }).locator('..').locator('dd'))
      .toHaveText(process.env.ANNOTATION_DIAGNOSTIC_BUILD === '1' ? '1' : '2');
  } finally { releaseResponse(); }
  await expect(reviews.locator('.metric').filter({ hasText: 'Details Collected' }).locator('strong')).toHaveText('2');
  expect(requested.sort()).toEqual([7000101, 7000102]);
  expect(requested).not.toContain(4010128);
  await expect(diagnostics).toContainText('DETAIL_REQUEST_STARTED annotationId=7000102');
  await expect(diagnostics).toContainText('DETAIL_REQUEST_SUCCESS annotationId=7000102 status=200');
  await expect(reviews.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('4.00');
  await reviews.getByLabel('Select review 7000101', { exact: true }).check();
  reviews.once('dialog', dialog => dialog.accept());
  await reviews.getByRole('button', { name: 'Force Refresh Selected Reviews' }).click();
  await expect.poll(() => requested.length).toBe(3);
  expect(requested.at(-1)).toBe(7000101);
  await expect(reviews.getByRole('button', { name: 'Fetch Review Scores', exact: true })).toBeEnabled();
  await reviews.getByRole('button', { name: 'Fetch Review Scores', exact: true }).click();
  await expect(reviews.getByText('No requests queued:', { exact: false })).toBeVisible();
  expect(requested).toHaveLength(3);
  const downloading = reviews.waitForEvent('download');
  await reviews.getByRole('button', { name: 'Export sanitized diagnostics' }).click();
  const file = await downloading;
  const report = await readFile((await file.path())!, 'utf8');
  expect(report).toContain('"skippedCache": 2');
  expect(report).not.toContain('aa_fixture_session');
  expect(report).not.toContain('currentVersionReview');
  await reviews.close(); await target.close();
  await context.unroute('https://www.linkedin.com/**');
});

test('website collection clicks, captures, resumes, stops on native 403 and reuses persistent cache offline (routed fixture, NOT real LinkedIn)', async () => {
  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${fixtureExtension}`, `--load-extension=${fixtureExtension}`, '--auto-open-devtools-for-tabs'],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const requested: number[] = [];
  await context.route('https://www.linkedin.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/ai-trainer/api/frontendAnnotationTaskResults/')) {
      expect(route.request().method()).toBe('GET');
      expect((await route.request().allHeaders())['x-aa-fixture-ui']).toBe('native');
      const id = Number(url.pathname.split('/').at(-1));
      requested.push(id);
      await route.fulfill({ status: id === 7000203 ? 403 : 200, contentType: 'application/json',
        body: JSON.stringify(id === 7000203 ? { error: 'Synthetic access refusal' } : reviewFixture(id, {
          pipeline: { id: 7001, name: 'Website fixture batch' }, pipelineStage: { id: 7101, type: 'ATTEMPT' },
        })) });
      return;
    }
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic native UI - not LinkedIn</title>
      <a id="task" href="/ai-trainer/tasks/7000201">Open first annotation</a><h1>Completed tasks fixture</h1>
      <script>
        function loadReview(id) {
          document.body.innerHTML = '<h1>Native review ' + id + '</h1>' +
            (id === 7000201 ? '<a href="/ai-trainer/tasks/7000202">Open second annotation through full navigation</a>' : '');
          fetch('/ai-trainer/api/frontendAnnotationTaskResults/' + id, { headers: { Accept: 'application/json', 'X-AA-Fixture-UI': 'native' } }).then(r => r.json());
        }
        document.getElementById('task').addEventListener('click', event => {
          event.preventDefault(); history.pushState(null, '', '/ai-trainer/tasks/7000201'); loadReview(7000201);
        });
        const match = location.pathname.match(/\\/tasks\\/(\\d+)$/);
        if (match) loadReview(Number(match[1]));
      </script>` });
  });
  const target = await context.newPage();
  await target.goto('https://www.linkedin.com/ai-trainer/completed');
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/ai-trainer/completed' });
    if (!tab?.id) throw new Error('Native fixture tab missing.');
    await chrome.storage.session.set({ targetTab: tab.id });
    return tab.id;
  });
  await expect.poll(async () => worker.evaluate(async id => (await chrome.storage.session.get(`devtools:${id}`))[`devtools:${id}`], tabId), { timeout: 20_000 }).toBe(true);
  let page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html?tab=${tabId}`);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear current results' }).click();
  await expect(page.locator('.metric').filter({ hasText: 'Total annotations' }).locator('strong')).toHaveText('0');
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Original response URL (optional)').fill('https://www.linkedin.com/ai-trainer/api/test-annotation-list');
  await page.locator('input[type=file]').setInputFiles({
    name: 'native-ui-list.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      records: [7000201, 7000202, 7000203].map(id => reviewFixture(id, { currentVersionReview: null })),
    })),
  });
  await expect(page.getByText('Imported 3 new unique annotations.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Review Analytics', exact: true }).click();
  await page.getByLabel('Pacing between request starts (ms)').fill('3000');
  await page.getByRole('button', { name: 'Collect through website', exact: true }).click();
  await expect(page.locator('.metric').filter({ hasText: 'Details Collected' }).locator('strong')).toHaveText('1');
  await expect(target.getByRole('heading', { name: 'Native review 7000201' })).toBeVisible();
  const background = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('/collection.html?job=')));
  // --auto-open-devtools-for-tabs can focus newly inspected tabs; the final test
  // verifies the inactive runner without that automation-only browser switch.
  expect(background?.autoDiscardable).toBe(false);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume saved queue', exact: true })).toBeEnabled();
  expect(requested).toEqual([7000201]);
  // Reopen the review route: ordinary navigation state is not encoded by the dashboard's tab-only URL.
  await page.goto(`chrome-extension://${extensionId}/dashboard.html?view=reviews&tab=${tabId}`);
  await page.getByRole('button', { name: 'Resume saved queue', exact: true }).click();
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fetch Review Scores', exact: true })).toHaveCount(0);
  await page.close();
  await expect.poll(() => requested.includes(7000202)).toBe(true);
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html?view=reviews&tab=${tabId}`);
  await expect(page.locator('.metric').filter({ hasText: 'Details Collected' }).locator('strong')).toHaveText('2');
  await expect(page.getByText("HTTP 403: the website's own request was refused.", { exact: false }).first()).toBeVisible();
  expect(requested).toEqual([7000201, 7000202, 7000203]);
  expect(requested).not.toContain(4010128);
  await expect(page.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('4.00');
  await expect(page.locator('.metric').filter({ hasText: 'Fetch Failures' }).locator('strong')).toHaveText('1');
  await expect(page.getByLabel('Collection method')).toHaveValue('website');
  const diagnostics = page.getByRole('region', { name: 'Detail collection diagnostics' });
  await expect(diagnostics).toContainText('website-owned requests captured');
  await expect(diagnostics).toContainText('DETAIL_REQUEST_SUCCESS annotationId=7000202 status=200');
  await expect(diagnostics).toContainText('DETAIL_REQUEST_FAILED annotationId=7000203 status=403');
  await expect(page.getByRole('button', { name: 'Collect through website', exact: true })).toBeEnabled();
  expect(await worker.evaluate(async id => (await chrome.storage.session.get(`website-detail:${id}`))[`website-detail:${id}`], tabId)).toBeUndefined();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Original response URL (optional)').fill('https://www.linkedin.com/ai-trainer/api/frontendAnnotationTaskResults/7000203');
  await page.locator('input[type=file]').setInputFiles({
    name: 'offline-third-review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reviewFixture(7000203, {
      currentVersionReview: { annotationScore: 2, status: 'REJECTED', feedback: 'Synthetic offline feedback' },
    }))),
  });
  await expect(page.getByText('Imported 0 new unique annotations.', { exact: false })).toBeVisible();
  await target.close();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html?view=reviews&tab=${tabId}`);
  await page.getByRole('button', { name: 'Collect through website', exact: true }).click();
  await expect(page.getByText('No requests queued:', { exact: false })).toBeVisible();
  const cached = page.getByRole('region', { name: 'Detail collection diagnostics' });
  await expect(cached.locator('dt').filter({ hasText: /^Annotation IDs skipped due to cache$/ }).locator('..').locator('dd')).toHaveText('3');
  await expect(cached.locator('dt').filter({ hasText: /^Requests started$/ }).locator('..').locator('dd')).toHaveText('0');
  expect(requested).toEqual([7000201, 7000202, 7000203]);
  await page.close();
  await context.unroute('https://www.linkedin.com/**');
});

test('main dashboard, popup and side panel load cached review analytics after browser restart without a website or requests', async () => {
  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${fixtureExtension}`, `--load-extension=${fixtureExtension}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const unexpectedRequests: string[] = [];
  await context.route('https://www.linkedin.com/**', async route => {
    unexpectedRequests.push(new URL(route.request().url()).pathname);
    await route.abort();
  });
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await expect(dashboard.locator('.metric').filter({ hasText: 'Details Collected' }).locator('strong')).toHaveText('3');
  await expect(dashboard.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('3.33');
  await expect(dashboard.getByText('Average Overall', { exact: true })).toHaveCount(0);
  await expect(dashboard.getByRole('button', { name: 'Fetch Review Scores', exact: true })).toHaveCount(0);
  await dashboard.getByRole('button', { name: 'Results', exact: true }).click();
  await expect(dashboard.getByRole('button', { name: 'Reviewer scores', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dashboard.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('3.33');
  await dashboard.getByRole('button', { name: 'Task answers', exact: true }).click();
  await expect(dashboard.getByText('No mapped task-answer scores', { exact: true })).toBeVisible();
  await expect(dashboard.getByText('Average Overall', { exact: true })).toHaveCount(0);
  await expect(dashboard.getByText('Overall distribution', { exact: true })).toHaveCount(0);
  await dashboard.getByRole('button', { name: 'Show cached reviewer scores', exact: true }).click();
  await expect(dashboard.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('3.33');
  await dashboard.getByLabel('Search reviews').fill('7000203');
  await expect(dashboard.locator('.metric').filter({ hasText: 'Details Collected' }).locator('strong')).toHaveText('1');
  await expect(dashboard.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('2.00');
  await dashboard.getByRole('button', { name: 'Export', exact: true }).click();
  const exporting = dashboard.waitForEvent('download');
  await dashboard.getByRole('button', { name: 'Download CSV' }).click();
  const file = await exporting;
  const csv = await readFile((await file.path())!, 'utf8');
  expect(csv).toContain('annotation_score');
  expect(csv).toContain('7000203');
  expect(csv).not.toContain('7000201');
  await dashboard.getByRole('button', { name: 'Clear review filters', exact: true }).click();
  await dashboard.getByRole('button', { name: 'Annotations', exact: true }).click();
  await expect(dashboard.getByRole('columnheader', { name: 'Reviewer score', exact: true })).toBeVisible();
  await expect(dashboard.getByRole('columnheader', { name: 'Overall', exact: true })).toHaveCount(0);
  const cachedRow = dashboard.getByRole('row').filter({ has: dashboard.getByRole('cell', { name: '7000201', exact: true }) });
  await expect(cachedRow).toContainText('APPROVED');
  await expect(cachedRow).toContainText('Website fixture batch');
  await expect(cachedRow).toContainText('ATTEMPT');
  await dashboard.getByRole('button', { name: 'Task-answer columns', exact: true }).click();
  await expect(dashboard.getByRole('columnheader', { name: 'Overall', exact: true })).toBeVisible();
  await expect(dashboard.getByRole('cell', { name: 'No task answer', exact: true }).first()).toBeVisible();
  await dashboard.getByRole('button', { name: 'Cached detail columns', exact: true }).click();
  await expect(dashboard.getByRole('columnheader', { name: 'Reviewer score', exact: true })).toBeVisible();
  await dashboard.getByRole('button', { name: 'Review Analytics', exact: true }).click();
  await expect(dashboard.getByRole('heading', { name: 'Review Analytics', exact: true })).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupCache = popup.getByRole('region', { name: 'Cached review analytics' });
  await expect(popupCache.locator('.metric').filter({ hasText: 'Cached review details' }).locator('strong')).toHaveText('3');
  await expect(popupCache.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('3.33');
  await expect(popup.getByText('TASK-ANSWER OVERALL', { exact: true })).toHaveCount(0);
  const taskOpening = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Task-answer results', exact: true }).click();
  const taskAnswers = await taskOpening;
  await expect(taskAnswers).toHaveURL(/view=results&data=answers$/);
  await expect(taskAnswers.getByRole('button', { name: 'Task answers', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(taskAnswers.getByText('No mapped task-answer scores', { exact: true })).toBeVisible();
  const opening = context.waitForEvent('page');
  await popupCache.getByRole('button', { name: 'Open Review Analytics' }).click();
  const reviews = await opening;
  await expect(reviews).toHaveURL(/dashboard\.html\?view=reviews$/);
  await expect(reviews.locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('3.33');
  const sidepanel = await context.newPage();
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(sidepanel.getByRole('region', { name: 'Cached review analytics' }).locator('.metric').filter({ hasText: 'Average Annotation Score' }).locator('strong')).toHaveText('3.33');
  expect(unexpectedRequests).toEqual([]);
  await taskAnswers.close(); await reviews.close(); await popup.close(); await sidepanel.close(); await dashboard.close();
  await context.unroute('https://www.linkedin.com/**');
});

test('closing a background runner interrupts safely and reopened controls resume or cancel without refetching completed refresh items (routed fixture)', async () => {
  const requested: number[] = [];
  await context.route('https://www.linkedin.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/ai-trainer/api/frontendAnnotationTaskResults/')) {
      const id = Number(url.pathname.split('/').at(-1));
      requested.push(id);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(reviewFixture(id)) });
    } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic fixture</title><p>No native requests</p>' });
  });
  const target = await context.newPage();
  await target.goto('https://www.linkedin.com/ai-trainer/completed');
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/ai-trainer/completed' });
    if (!tab?.id) throw new Error('Refresh fixture tab missing.');
    await chrome.storage.session.set({ targetTab: tab.id });
    return tab.id;
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html?view=reviews&tab=${tabId}`);
  await page.getByLabel('Collection method').selectOption('session');
  await page.getByLabel('Pacing between request starts (ms)').fill('3000');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Refresh Existing Reviews', exact: true }).click();
  const diagnostics = page.getByRole('region', { name: 'Detail collection diagnostics' });
  const completed = diagnostics.locator('dt').filter({ hasText: /^Requests completed$/ }).locator('..').locator('dd');
  await expect(completed).toHaveText('1');
  expect(requested).toEqual([7000201]);
  const background = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('/collection.html?job=')));
  expect(background?.active).toBe(false);
  expect(background?.autoDiscardable).toBe(false);
  await worker.evaluate(async () => {
    const runner = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/collection.html?job='));
    if (!runner?.id) throw new Error('Active collection runner missing.');
    await chrome.tabs.remove(runner.id);
  });
  await expect(diagnostics.locator('dt').filter({ hasText: /^Active collection state$/ }).locator('..').locator('dd')).toHaveText('interrupted');
  await page.reload();
  await page.getByRole('button', { name: 'Resume saved queue', exact: true }).click();
  await expect(completed).toHaveText('2');
  expect(requested).toEqual([7000201, 7000202]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(diagnostics.locator('dt').filter({ hasText: /^Active collection state$/ }).locator('..').locator('dd')).toHaveText('cancelled');
  await page.getByRole('button', { name: 'Resume saved queue', exact: true }).click();
  await expect(completed).toHaveText('3');
  await expect(page.getByRole('button', { name: 'Fetch Review Scores', exact: true })).toBeEnabled();
  expect(requested).toEqual([7000201, 7000202, 7000203]);
  await page.getByRole('button', { name: 'Fetch Review Scores', exact: true }).click();
  await expect(page.getByText('No requests queued:', { exact: false })).toBeVisible();
  expect(requested).toEqual([7000201, 7000202, 7000203]);
  await page.close(); await target.close();
  await context.unroute('https://www.linkedin.com/**');
});

test('Greenlight financials capture native JSON, collect rendered rates, reconcile corrections, navigate a bounded week and persist offline (synthetic fixture, NOT real account)', async () => {
  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${fixtureExtension}`, `--load-extension=${fixtureExtension}`, '--auto-open-devtools-for-tabs'],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const paths: string[] = [];
  await context.route('https://app.greenlight.ai/**', async route => {
    const url = new URL(route.request().url());
    paths.push(url.pathname);
    expect(route.request().method()).toBe('GET');
    expect((await route.request().allHeaders())['x-fixture-native']).toBe('website');
    expect((await route.request().allHeaders()).authorization).toBeUndefined();
    const start = url.searchParams.get('start')!;
    const end = url.searchParams.get('end')!;
    const week = start.slice(8, 10);
    const payload = week === '12' ? financeFixture() : financeFixture({
      start, end,
      deliverables: [{ id: 'delivery-previous', amount: 21.67, date: '2026-10-11T00:00:00', status: 4, engagementId: 'engagement-fixture',
        engagementTag: { name: 'PROJECT-FIXTURE' }, notes: 'PROJECT-FIXTURE|Previous batch- Att: 1, Rev: 0;' }],
    });
    await route.fulfill({ status: week === '28' ? 403 : 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(week === '28' ? { error: 'Synthetic native access refusal' } : payload) });
  });
  await context.route('https://portal.greenlight.ai/**', async route => {
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic Greenlight fixture</title><main id="content"></main>
      <script>
        const markup = ${JSON.stringify(greenlightMarkup())};
        let previous = 0;
        function draw() {
          const day = previous === 0 ? '12' : previous === 1 ? '05' : '28';
          const last = previous === 0 ? '18' : previous === 1 ? '11' : '04';
          const month = previous === 2 ? '09' : '10';
          const period = previous === 0 ? 'Week of Oct 12th, 2026 - Oct 18th, 2026' :
            previous === 1 ? 'Week of Oct 5th, 2026 - Oct 11th, 2026' : 'Week of Sep 28th, 2026 - Oct 4th, 2026';
          document.getElementById('content').innerHTML = markup.replace('Week of Oct 12th, 2026 - Oct 18th, 2026', period);
          if (previous > 0) {
            document.querySelectorAll('.container_rowGroup__fixture')[1].remove();
            document.querySelector('.quick_header__fixture').textContent = 'Deliverables (1)';
            const row = document.querySelector('.container_data__fixture');
            row.children[2].children[0].textContent = previous === 1 ? '10/11/2026' : '10/04/2026';
            row.children[3].textContent = '$21.67';
          }
          document.getElementById('previous').onclick = () => { previous++; draw(); };
          const endMonth = previous === 2 ? '10' : month;
          const url = 'https://app.greenlight.ai/ui/suppliers/S-fixture/time?start=' +
            encodeURIComponent('2026-' + month + '-' + day + 'T00:00:00') + '&end=' +
            encodeURIComponent('2026-' + endMonth + '-' + last + 'T23:59:59');
          fetch(url, { headers: { 'X-Fixture-Native': 'website' } }).then(r => r.json());
        }
        draw();
      </script>` });
  });
  const target = await context.newPage();
  await target.goto('https://portal.greenlight.ai/dashboard');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://portal.greenlight.ai/dashboard' }))[0]?.id);
  expect(tabId).toBeDefined();
  await expect.poll(() => worker.evaluate(async id => (await chrome.storage.session.get(`devtools:${id}`))[`devtools:${id}`], tabId), { timeout: 20_000 }).toBe(true);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html?view=financials`);
  await page.getByRole('button', { name: 'Find Greenlight tab', exact: true }).click();
  await page.getByRole('button', { name: 'Collect rendered week & rates', exact: true }).click();
  await expect(page.getByText('Saved 2 rendered deliverables and 1 rates', { exact: false })).toBeVisible();
  const summary = page.getByRole('region', { name: 'Cached financial summary' });
  await expect(summary.locator('.metric').filter({ hasText: 'Paid earnings' }).locator('strong')).toHaveText('$325.00');
  await expect(summary.locator('.metric').filter({ hasText: 'Paid annotation tasks' }).locator('strong')).toHaveText('Not available');
  await page.getByRole('button', { name: 'Start financial capture', exact: true }).click();
  await target.reload();
  await expect(page.getByRole('table', { name: 'Financial payment ledger' }).locator('tbody tr')).toHaveCount(3);
  await expect(summary.locator('.metric').filter({ hasText: 'Paid earnings' }).locator('strong')).toHaveText('$325.00');
  await expect(summary.locator('.metric').filter({ hasText: 'Paid annotation tasks' }).locator('strong')).toHaveText('15');
  await expect(summary.locator('.metric').filter({ hasText: 'Pending payments' }).locator('strong')).toHaveText('$43.34');
  const beforeUnaccounted = Number(await summary.locator('.metric').filter({ hasText: 'Completed attempts not in ledger (estimate)' }).locator('strong').textContent());
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Original response URL (optional)').fill('https://www.linkedin.com/ai-trainer/api/list');
  await page.locator('input[type=file]').setInputFiles({ name: 'finance-annotation-list.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    records: [
      ...Array.from({ length: 14 }, (_, index) => fixture(String(9000000 + index), { iterationId: 'iteration-fixture',
        pipeline: { id: 'finance-batch-fixture' }, iteration: { id: 'iteration-fixture' },
        ...(index === 0 ? { project: { id: 'project-1', projectConfig: 'not-retained', pipelines: [
          { id: 'finance-batch-fixture', name: 'Batch A', stages: [{ iterationId: 'iteration-fixture', type: 'ATTEMPT' }, { iterationId: 'review-fixture', type: 'REVIEW' }] },
          { id: 'unbilled-pipeline', name: 'Unbilled fixture batch', stages: [{ iterationId: 'unbilled-fixture', type: 'ATTEMPT' }] },
        ] } } : {}) })),
      fixture('9000014', { iterationId: 'review-fixture', pipeline: { id: 'finance-batch-fixture' },
        iteration: { id: 'review-fixture' } }),
      ...[9000015, 9000016].map(id => fixture(String(id), { iterationId: 'unbilled-fixture',
        pipeline: { id: 'unbilled-pipeline' }, iteration: { id: 'unbilled-fixture' } })),
    ],
  })) });
  await expect(page.getByText('Imported 17 new unique annotations.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Financials', exact: true }).click();
  const match = page.getByRole('table', { name: 'Automatic financial batch matches' }).locator('tbody tr')
    .filter({ has: page.getByRole('cell', { name: 'PROJECT-FIXTURE · Batch A', exact: true }) });
  await expect(match).toContainText('Matched · project project-1 · pipeline finance-batch-fixture');
  await expect(match.locator('td').nth(2)).toHaveText('14 / 1');
  await expect(match.locator('td').nth(3)).toHaveText('9 / 0');
  await expect(match.locator('td').nth(4)).toHaveText('2 / 1');
  await expect(match.locator('td').nth(5)).toHaveText('3');
  const unbilled = page.getByRole('table', { name: 'Automatic financial batch matches' }).locator('tbody tr').filter({ hasText: 'Unbilled fixture batch' });
  await expect(unbilled).toContainText('No payment in cache');
  await expect(unbilled.locator('td').nth(5)).toHaveText('2');
  await expect(summary.locator('.metric').filter({ hasText: 'Completed attempts not in ledger (estimate)' }).locator('strong')).toHaveText(String(beforeUnaccounted + 5));
  await expect(summary.locator('.metric').filter({ hasText: 'Total pending attempts (estimate)' }).locator('strong')).toHaveText(String(beforeUnaccounted + 7));
  await expect(summary.locator('.metric').filter({ hasText: 'Remaining earnings estimate (observed batch rates)' }).locator('strong')).toHaveText('$108.33');
  await expect(summary.locator('.metric').filter({ hasText: 'Pending + unbilled estimate (observed rates)' }).locator('strong')).toHaveText('$108.34');
  await expect(match.locator('td').nth(8)).toContainText('$65.00 / 3 paid');
  await expect(match.locator('td').nth(8)).toContainText('remaining ~$108.33');
  await page.getByLabel('Greenlight batch', { exact: true }).selectOption({ label: 'PROJECT-FIXTURE · Batch A' });
  await page.getByLabel('Annotation scope', { exact: true }).selectOption('iteration-fixture');
  await page.getByLabel('USD rate per submitted annotation', { exact: true }).fill('21.67');
  await page.getByRole('checkbox', { name: 'I confirm this complete annotation scope', exact: false }).check();
  await page.getByRole('button', { name: 'Save confirmed batch mapping', exact: true }).click();
  await expect(summary.locator('.metric').filter({ hasText: 'Unbilled earnings estimate' }).locator('strong')).toHaveText('$65.01');
  await expect(summary.locator('.metric').filter({ hasText: 'To be earned / received estimate' }).locator('strong')).toHaveText('$108.35');
  await page.getByRole('button', { name: 'Annotations', exact: true }).click();
  await page.getByLabel('Annotation batch join', { exact: true }).selectOption('batch a');
  await page.getByLabel('Annotation batch payment coverage', { exact: true }).selectOption('remaining');
  await page.getByLabel('Search annotations', { exact: true }).fill('9000000');
  const annotationRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '9000000', exact: true }) });
  await expect(annotationRow).toContainText('Partially paid batch');
  const annotationExporting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const annotationCsv = await readFile((await (await annotationExporting).path())!, 'utf8');
  expect(annotationCsv).toContain('batch_join_key');
  expect(annotationCsv).toContain('batch_remaining_to_pay');
  expect(annotationCsv).toContain('"Partially paid batch","9","5"');
  expect(annotationCsv).not.toContain('"9000001"');
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page.getByRole('button', { name: 'Financials', exact: true }).click();
  await page.getByLabel('Payment state', { exact: true }).selectOption('pending');
  await expect(page.getByRole('table', { name: 'Financial payment ledger' }).locator('tbody tr')).toHaveCount(1);
  const exporting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export financials', exact: true }).click();
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const csv = await readFile((await (await exporting).path())!, 'utf8');
  expect(csv).toContain('"43.34","Pending"');
  expect(csv).not.toContain('delivery-correction');
  await page.getByRole('button', { name: 'Export financials', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Format').selectOption('json');
  const reporting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const report = JSON.parse(await readFile((await (await reporting).path())!, 'utf8'));
  expect(report.payments).toHaveLength(1);
  expect(report.observedBatchEarnings.remainingCents).toBe(10833);
  expect(report.reconciliation.rows.find((row: { batch: string }) => row.batch === 'Batch A').paidAttempts).toBe(9);
  await page.getByRole('button', { name: 'Clear financial filters', exact: true }).click();
  await page.getByRole('button', { name: 'Find Greenlight tab', exact: true }).click();
  await page.getByRole('button', { name: 'Capture previous week', exact: true }).click();
  await expect(page.getByText('Previous week captured and rendered data saved.', { exact: false })).toBeVisible();
  await expect(summary.locator('.metric').filter({ hasText: 'Paid earnings' }).locator('strong')).toHaveText('$346.67');
  await page.getByRole('button', { name: 'Capture previous week', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'HTTP 403' }).first()).toBeVisible();
  await expect(page.getByText('Latest HTTP status').locator('..').locator('dd')).toHaveText('403');
  await expect(page.getByText('Capture state', { exact: true }).locator('..').locator('dd')).toHaveText('Stopped');
  expect(paths.every(path => path === new URL(financeUrl).pathname)).toBe(true);
  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${fixtureExtension}`, `--load-extension=${fixtureExtension}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const unexpected: string[] = [];
  await context.route('https://**.greenlight.ai/**', async route => { unexpected.push(route.request().url()); await route.abort(); });
  for (const file of ['dashboard.html', 'popup.html', 'sidepanel.html']) {
    const offline = await context.newPage();
    await offline.goto(`chrome-extension://${extensionId}/${file}`);
    const cached = offline.getByRole('region', { name: 'Cached financial summary' });
    await expect(cached.locator('.metric').filter({ hasText: 'Paid earnings' }).locator('strong')).toHaveText('$346.67');
    await expect(cached.locator('.metric').filter({ hasText: 'Pending payments' }).locator('strong')).toHaveText('$43.34');
    await expect(cached.locator('.metric').filter({ hasText: 'Unbilled earnings estimate' }).locator('strong')).toHaveText('$65.01');
    await expect(cached.locator('.metric').filter({ hasText: 'Remaining earnings estimate (observed batch rates)' }).locator('strong')).toHaveText('$108.33');
    await expect(cached.locator('.metric').filter({ hasText: 'Pending + unbilled estimate (observed rates)' }).locator('strong')).toHaveText('$108.34');
    await expect(cached).toContainText('1 / 3 payment batches matched to cached annotation pipelines');
    await offline.close();
  }
  expect(unexpected).toEqual([]);
  await context.unroute('https://**.greenlight.ai/**');
});
