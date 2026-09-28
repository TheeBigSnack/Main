// A tiny static server for developing the test drive: serves the repository
// root so demo/ can load ../extension/ unchanged. Plain Node, no dependencies.
// Once hosted (any static host that serves the repo root, or the demo/ and
// extension/ folders side by side), no server is needed.
//
//   node demo/serve.mjs            -> http://127.0.0.1:8765/demo/
//   node demo/serve.mjs 9000       -> another port
//   PORT=9000 node demo/serve.mjs
//
// demo/drive.mjs imports startServer() and picks a free port.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function startServer({ port = 0, host = '127.0.0.1', root = ROOT, quiet = true } = {}) {
  const base = resolve(root);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' });
      return res.end('The test drive is static: only GET.');
    }
    let file = normalize(join(base, decodeURIComponent(url.pathname)));
    if (!file.startsWith(base + sep) && file !== base) {
      res.writeHead(403);
      return res.end();
    }
    try {
      let s = await stat(file);
      if (s.isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          res.writeHead(301, { location: url.pathname + '/' + url.search });
          return res.end();
        }
        file = join(file, 'index.html');
        s = await stat(file);
      }
      const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'content-length': s.size, 'cache-control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      return res.end(await readFile(file));
    } catch (e) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found: ' + url.pathname);
    }
  });
  return new Promise((ok, fail) => {
    server.on('error', fail);
    server.listen(port, host, () => {
      if (!quiet) console.log(`Lot Sync test drive: http://${host}:${server.address().port}/demo/`);
      ok(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || process.env.PORT || 8765);
  startServer({ port, quiet: false }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
