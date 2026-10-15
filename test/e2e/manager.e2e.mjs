// End-to-end smoke test of the manager view (I-26). The page is served from
// this machine and opened in its sample-data mode (?mock=1): a made-up
// dealership, no account server. The test checks that it opens and shows the
// dealership, that Download CSV saves a file whose header row is the
// spreadsheet's, that the page makes no request off this server (sample mode
// never touches the network), and that it throws no page or console error.
// Fixtures only: no real dealership data is used or shown.
//
// Run: npm run test:e2e:manager

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mockData, managerCsv } from '../../manager/data.js';
import { until } from './until.mjs';
import { closeBounded } from './closeBounded.mjs';

const manager = fileURLToPath(new URL('../../manager/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Serves the manager folder on a free local port, and nothing outside it.
function serveManager() {
  const server = createServer(async (req, res) => {
    let file;
    try {
      file = join(manager, new URL(req.url, 'http://manager.test').pathname.replace(/^\/+/, '') || 'index.html');
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    if (!file.startsWith(manager)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(body);
    } catch (e) {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const server = await serveManager();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.LOTSYNC_E2E_CHANNEL || 'chromium', headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const problems = [];
const outside = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) outside.push(r.url()); });

try {
  await page.goto(`${base}/index.html?mock=1`);
  await until(page, () => (document.body.textContent || '').includes('Example Motors'), undefined, { what: 'the sample dealership on the page' });
  assert.equal(await page.locator('button[data-action="csv"]').count(), 1, 'the Download CSV button is on the page');

  // the file the button saves has the spreadsheet's header row
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action="csv"]')]);
  const csv = await readFile(await download.path(), 'utf8');
  // the title row names the dealership and the export time (the time is left out of the check), and the
  // header rows that follow (website, time zone, the summary's column names) are the spreadsheet's own
  const origin = 'https://www.example-motors-springfield.test';
  const expected = managerCsv(mockData(), { dealer: 'Example Motors', origin }).split('\n').map((line) => line.replace(/\r$/, ''));
  const got = csv.split('\n').map((line) => line.replace(/\r$/, ''));
  const titleOf = (line) => line.replace(/,exported .*$/, '');
  assert.equal(titleOf(got[0]), titleOf(expected[0]), 'the title row names the dealership');
  assert.deepEqual(got.slice(1, 5), expected.slice(1, 5), 'the header rows are the spreadsheet\'s');
  assert.match(download.suggestedFilename(), /\.csv$/);

  assert.deepEqual(outside, [], 'sample mode makes no request off this server');
  assert.deepEqual(problems, [], 'no page error or console error');
  console.log('Manager E2E passed: sample page, CSV download, no outside requests, no errors.');
} finally {
  await closeBounded(context);
  await browser.close().catch(() => {});
  server.close();
}
