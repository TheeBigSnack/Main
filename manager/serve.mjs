// Serves this folder on localhost for a demo from disk: Chrome and Safari
// refuse to load ES modules from a file:// address. No dependencies.
//   node manager/serve.mjs         then open the address it prints
//   PORT=9000 node manager/serve.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const port = Number(process.env.PORT) || 8787;

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.endsWith(sep) || path.endsWith('/')) path += 'index.html';
  const file = join(root, path);
  if (!file.startsWith(root)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Lot Sync manager view: http://127.0.0.1:${port}/?mock=1 (sample data), http://127.0.0.1:${port}/ (live)`);
});
