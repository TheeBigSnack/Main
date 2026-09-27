// A stand-in for Facebook's "Create vehicle listing" page, for the end-to-end
// test. Its fields are addressed by role and accessible name the same way
// extension/facebook/formMap.js addresses the real form, so the test proves
// that the find-by-name approach and the fill code work, not that Facebook's
// current page matches (that needs a real, signed-in check; see README).
// The real facebook.com is never automated in tests.
//
// It mimics what the first live run (2026-09-27) showed about the real form:
//   - dropdowns are custom comboboxes whose option list is drawn late
//     (the Year list here takes 2.5 s), and only one popup is open at a time:
//     clicking another dropdown just closes the open one;
//   - the price box reformats what you type ("27163" -> "27,163").
// It mixes control types (custom comboboxes, native selects, inputs, a
// textarea, a file input) plus the two fields the extension must never touch
// (condition, title status). Only a person clicks Publish; the server counts
// those clicks so the test can prove it.

import http from 'node:http';

let publishClicks = 0;

const opts = (list) => '<option value=""></option>' + list.map((o) => `<option>${o}</option>`).join('');
const COLORS = ['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Grey', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Tan', 'Beige', 'Burgundy', 'Turquoise', 'Off white', 'Other'];
const YEARS = [];
for (let y = 2027; y >= 1990; y -= 1) YEARS.push(String(y));

// A custom dropdown: a combobox control plus a listbox drawn `delay` ms after the click.
const combo = (id, label, options, delay) =>
  `<div>${label}
    <div id="${id}" role="combobox" aria-label="${label}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}List" tabindex="0" data-value="" data-delay="${delay}">Select</div>
    <div id="${id}List" role="listbox" hidden></div>
    <template id="${id}Options">${options.map((o) => `<div role="option">${o}</div>`).join('')}</template>
  </div>`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Create vehicle listing (mock)</title>
<style>body{font:14px system-ui;max-width:640px;margin:20px auto}label{display:block;margin:8px 0}[role=listbox]{border:1px solid #999;padding:4px;width:200px;max-height:160px;overflow:auto}[role=option]{padding:2px 6px;cursor:pointer}[hidden]{display:none}[role=combobox]{border:1px solid #999;padding:4px 8px;width:200px;cursor:pointer}</style>
</head><body>
<h1>Create vehicle listing (mock)</h1>
<p>Add up to 20 photos.</p>
<form onsubmit="return false">
  <label for="photos">Add photos</label>
  <input id="photos" type="file" multiple accept="image/*"> <span id="photoCount">0 photos</span>
  ${combo('vehicleType', 'Vehicle type', ['Car/Truck', 'Motorcycle', 'Powersport', 'RV/Camper', 'Trailer', 'Boat', 'Commercial/Industrial', 'Other'], 0)}
  ${combo('year', 'Year', YEARS, 2500)}
  <div id="makeWrap" hidden>${combo('make', 'Make', ['Chevrolet', 'Dodge', 'Ford', 'Honda', 'Jeep', 'Ram', 'Toyota'], 300)}</div>
  <label>Model <input id="model"></label>
  <label>Mileage <input id="mileage"></label>
  <label>Price <input id="price"></label>
  <label>Body style <select id="bodyStyle">${opts(['Convertible', 'Coupe', 'Hatchback', 'Minivan', 'Truck', 'SUV', 'Sedan', 'Van', 'Wagon', 'Other'])}</select></label>
  ${combo('exteriorColor', 'Exterior color', COLORS, 300)}
  <label>Interior color <select id="interiorColor">${opts(COLORS)}</select></label>
  <label>Vehicle condition <select id="condition">${opts(['Excellent', 'Very good', 'Good', 'Fair', 'Poor'])}</select></label>
  <label>Fuel type <select id="fuelType">${opts(['Diesel', 'Electric', 'Gasoline', 'Flex', 'Hybrid', 'Petrol', 'Plug-in hybrid', 'Other'])}</select></label>
  <label>Transmission <select id="transmission">${opts(['Automatic transmission', 'Manual transmission'])}</select></label>
  <label>Title status <select id="titleStatus">${opts(['Clean', 'Rebuilt', 'Salvage', 'Lien', 'Missing'])}</select></label>
  <label>Location <input id="location" role="combobox" aria-autocomplete="list" aria-controls="locationList" autocomplete="off"></label>
  <div id="locationList" role="listbox" hidden></div>
  <label>Description <textarea id="description" rows="10" cols="60"></textarea></label>
  <button type="button" id="publish">Publish</button>
</form>
<script>
  // One popup at a time, like the real page: clicking a control while another
  // list is open only closes that list.
  let openList = null;
  const closeOpen = () => { if (!openList) return; openList.hidden = true; document.getElementById(openList.id.replace(/List$/, '')).setAttribute('aria-expanded', 'false'); openList = null; };
  for (const cb of document.querySelectorAll('div[role=combobox]')) {
    const list = document.getElementById(cb.id + 'List');
    cb.addEventListener('click', () => {
      if (openList) { const wasMine = openList === list; closeOpen(); if (wasMine) return; return; }
      setTimeout(() => {
        if (openList) return;
        list.innerHTML = document.getElementById(cb.id + 'Options').innerHTML;
        list.hidden = false;
        cb.setAttribute('aria-expanded', 'true');
        openList = list;
      }, Number(cb.dataset.delay));
    });
    list.addEventListener('click', (e) => {
      const o = e.target.closest('[role=option]');
      if (!o) return;
      cb.textContent = o.textContent;
      cb.dataset.value = o.textContent;
      closeOpen();
      // Like the real form: the Make control only appears a moment after a year is chosen.
      if (cb.id === 'year') setTimeout(() => { document.getElementById('makeWrap').hidden = false; }, 1000);
    });
  }
  // Location typeahead. Several towns share the name; the wrong state comes first.
  const loc = document.getElementById('location');
  const locList = document.getElementById('locationList');
  let locTimer = null;
  loc.addEventListener('input', () => {
    clearTimeout(locTimer);
    locTimer = setTimeout(() => {
      const q = loc.value.trim().toLowerCase();
      const names = /^\\d/.test(q) ? ['Waynesburg, Pennsylvania'] : q.startsWith('wayne') ? ['Waynesburg, Ohio', 'Waynesburg, Pennsylvania', 'Waynesburg, Kentucky'] : [];
      if (openList && openList !== locList) closeOpen();
      locList.innerHTML = names.map((n) => '<div role="option">' + n + '<span> City</span></div>').join('');
      locList.hidden = !names.length;
      openList = names.length ? locList : null;
    }, 200);
  });
  locList.addEventListener('click', (e) => {
    const o = e.target.closest('[role=option]');
    if (!o) return;
    loc.value = o.firstChild.textContent;
    closeOpen();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpen(); });
  document.addEventListener('mousedown', (e) => { if (openList && !e.target.closest('[role=listbox],[role=combobox]')) closeOpen(); });
  // The price box reformats digits with thousands separators, like the real one.
  document.getElementById('price').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\\D/g, '');
    e.target.value = digits ? Number(digits).toLocaleString('en-US') : '';
  });
  let photos = 0;
  document.getElementById('photos').addEventListener('change', (e) => {
    photos += e.target.files.length;
    document.getElementById('photoCount').textContent = photos + ' photos';
  });
  // Only a person clicks this. The extension has no code path to it.
  document.getElementById('publish').addEventListener('click', async () => {
    await fetch('/published', { method: 'POST' });
    location.href = '/marketplace/item/424242/';
  });
</script></body></html>`;

export function startMockMarketplace(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/published') {
      publishClicks += 1;
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/publish-count') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(String(publishClicks));
    }
    if (/^\/marketplace\/item\/\d+\/?$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Your listing (mock)</title></head><body><h1>Listing 424242 is live (mock)</h1></body></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
