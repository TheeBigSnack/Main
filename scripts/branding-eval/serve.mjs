// A static server for the harness (127.0.0.1, a random port) and a headless
// Chromium page on it. It serves only this folder's files and the module
// under test (extension/src/photoBranding.js), so the harness always measures
// the code that ships, never a copy.
//
// Chromium: found by scripts/site-check.mjs's chromePath(), the same rule as
// demo/drive.mjs (the Chrome-path environment variable the repo's scripts
// read, else the preinstalled /opt/pw-browsers/chromium-1194/chrome-linux/chrome
// when it exists, else Playwright's own: npx playwright install chromium).
// Outputs (results files, sweeps, contact sheets) go to OUT_DIR, under the
// OS temp folder: nothing the harness writes lands in the repository.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromePath } from '../site-check.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..');
const MODULE = join(repo, 'extension', 'src', 'photoBranding.js');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

export const OUT_DIR = join(tmpdir(), 'lot-current-branding-eval');

export async function outDir() {
  await mkdir(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

// A file the page may load: one of this folder's .js or .html files, or the module.
function allowed(urlPath) {
  let file;
  try {
    file = resolve(repo, '.' + decodeURIComponent(urlPath));
  } catch {
    return null;
  }
  if (file === MODULE) return file;
  const rest = file.startsWith(here) ? file.slice(here.length) : null;
  if (rest && !rest.includes(sep) && /\.(js|html)$/.test(rest)) return file;
  return null;
}

export async function open() {
  const server = http.createServer(async (req, res) => {
    const file = allowed(new URL(req.url, 'http://127.0.0.1').pathname);
    try {
      if (!file) throw new Error('not served');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)], 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/scripts/branding-eval/harness.html`;
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  return { page, close: async () => { await browser.close(); server.close(); } };
}
