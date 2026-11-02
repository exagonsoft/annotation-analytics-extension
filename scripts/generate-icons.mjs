import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('../public/icons/', import.meta.url));
const svg = await readFile(join(directory, 'annotation-analytics.svg'), 'utf8');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.locator('svg').screenshot({ path: join(directory, `icon${size}.png`), omitBackground: true });
  }
} finally {
  await browser.close();
}
