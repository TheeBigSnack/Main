// A stand-in for a dealership website that publishes standard vehicle data
// (schema.org Car, Vehicle and Offer markup, as Google's vehicle listing
// documentation describes it) instead of an inventory search service, for
// testing the extension end to end without touching any real website. The
// dealership ("Example Auto Outlet"), its cars and its pages are the
// sandbox's second sample (demo/site-standard/inventory.js, loaded here the
// way test/demo.test.js loads it), served the way a real server would serve
// them:
//   /used-vehicles/            the used-inventory list, 4 cars a page, rel=next
//   /inventory/<car>/          each car's page: JSON-LD, an @graph, microdata
//                              only, or a carousel of other cars
//   /new-vehicles/, /          the new cars, the home page
//   /robots.txt, /sitemap.xml  the sitemap lists the used cars' pages
//   /photos/<car>-<n>.png      same-origin photos
// Test controls:
//   /scenario?name=day2        the Accord sells (its page answers 404), the
//                              Civic drops $1,000, the Wrangler gets photos, a
//                              Tucson arrives; &soldPage=301 redirects the sold
//                              car's page to the list instead, &soldPage=200
//                              answers a "no longer available" page
//   /flaky?on=1                a server having a bad day: the page of a car that
//                              is not on the website (sold, or never there)
//                              answers 429 (Retry-After: 1) whatever soldPage
//                              says, and the Sorento's page answers 500; ?on=0
//                              ends it
//   /requests                  what was asked, in order ({ method, path, status, ua });
//                              ?clear=1 empties the list
// It never looks at who is asking: every visitor gets the same answer.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ window: {}, URL });
vm.runInContext(readFileSync(new URL('../../demo/site-standard/inventory.js', import.meta.url), 'utf8'), context, { filename: 'inventory.js' });
export const STANDARD = context.window.LOT_SYNC_STANDARD;

// The car pages link to their Carfax report on a real server; the sandbox's copy has no such links.
const carfax = (c) => `https://www.carfax.com/VehicleHistory/p/Report.cfx?vin=${c.vin}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const CONTROLS = new Set(['/scenario', '/flaky', '/requests']);

export function startMockStandardSite(port = 0) {
  let scenario = { name: 'day1' };
  let flaky = false;
  const requests = [];

  const server = http.createServer((req, res) => {
    const origin = 'http://' + req.headers.host;
    const url = new URL(req.url, origin);
    const send = (status, type, body, headers = {}) => {
      // the user agent is recorded so the flow can check Lot Current never changes it
      if (!CONTROLS.has(url.pathname)) requests.push({ method: req.method, path: url.pathname + url.search, status, ua: req.headers['user-agent'] || '' });
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (url.pathname === '/scenario') {
      const name = url.searchParams.get('name') === 'day2' ? 'day2' : 'day1';
      scenario = { name, soldPage: url.searchParams.get('soldPage') || '404' };
      return send(200, 'text/plain', `${name}${name === 'day2' ? ', sold page ' + STANDARD.day2Plan(scenario).soldPage : ''}`);
    }
    if (url.pathname === '/flaky') {
      flaky = url.searchParams.get('on') === '1';
      return send(200, 'text/plain', flaky ? 'flaky on' : 'flaky off');
    }
    if (url.pathname === '/requests') {
      const list = requests.slice();
      if (url.searchParams.get('clear') === '1') requests.length = 0;
      return send(200, 'application/json', JSON.stringify(list));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Only GET and HEAD.', { allow: 'GET, HEAD' });

    const photo = /^\/photos\/([a-z0-9]+)-(\d+)\.png$/.exec(url.pathname);
    if (photo) {
      const car = STANDARD.CARS.find((c) => c.key === photo[1]);
      return car ? send(200, 'image/png', PNG) : send(404, 'text/plain', 'Not found');
    }

    const site = STANDARD.pathSite(origin, { carfax });
    const answer = STANDARD.respond(url.href, scenario, site);
    if (!answer) return send(404, 'text/plain', 'Not found');
    if (flaky && /^\/inventory\//.test(url.pathname)) {
      const page = url.pathname.replace(/\/?$/, '/');
      const car = STANDARD.onWebsite(scenario).find((c) => STANDARD.vehicleRoute(c) === page);
      if (!car) return send(429, 'text/plain', 'Too many requests. Try again in a second.', { 'retry-after': '1' });
      if (car.key === 'sorento') return send(500, 'text/plain', 'Internal server error');
    }
    return send(answer.status, answer.type, answer.body, answer.location ? { location: answer.location } : {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
