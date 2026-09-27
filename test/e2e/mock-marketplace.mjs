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
// Like Facebook restoring a saved draft: after GET /prefill?name=honda the
// create page opens already holding another car.
const PREFILLS = {
  none: null,
  honda: { year: '2020', make: 'Honda', model: 'Accord EX-L', vin: '1HGCV1F30LA000000', mileage: '31200', description: 'Low miles, garage kept. Serious buyers only.' },
};
let prefill = null;

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
  <div id="makeWrap" hidden><label>Make <input id="make" role="combobox" aria-autocomplete="list" aria-controls="makeList" autocomplete="off"></label><div id="makeList" role="listbox" hidden></div></div>
  <label>Model <input id="model" role="combobox" aria-autocomplete="list" aria-controls="modelList" autocomplete="off"></label><div id="modelList" role="listbox" hidden></div>
  <label>VIN <input id="vin"></label>
  <label>Mileage <input id="mileage"></label>
  <label>Price <input id="price"></label>
  <label>Body style <select id="bodyStyle">${opts(['Convertible', 'Coupe', 'Hatchback', 'Minivan', 'Truck', 'SUV', 'Sedan', 'Van', 'Wagon', 'Other'])}</select></label>
  ${combo('exteriorColor', 'Exterior color', COLORS, 300)}
  <label>Interior color <select id="interiorColor">${opts(COLORS)}</select></label>
  <label>Vehicle condition <select id="condition">${opts(['Excellent', 'Very good', 'Good', 'Fair', 'Poor'])}</select></label>
  <label>Fuel type <select id="fuelType">${opts(['Diesel', 'Electric', 'Gasoline', 'Flex', 'Hybrid', 'Petrol', 'Plug-in hybrid', 'Other'])}</select></label>
  <label>Transmission <select id="transmission">${opts(['Automatic transmission', 'Manual transmission'])}</select></label>
  <label>Title status <select id="titleStatus">${opts(['Clean', 'Rebuilt', 'Salvage', 'Lien', 'Missing'])}</select></label>
  <div><b>Vehicle details</b><div>Include more details to help connect interested buyers to your vehicle.</div>
    <div><div><b>This vehicle has a clean title.</b><div>This vehicle has no significant damage or persistent problems.</div></div><input type="checkbox" id="cleanTitle"></div>
  </div>
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
  // Make and Model typeaheads, like the real form: default suggestions on
  // focus (Honda first, then Accord), filtered only by real key presses, and
  // the first suggestion is committed when the box loses focus. Text set
  // without key events therefore turns into Honda / Accord on blur.
  function typeaheadField(id, all, defaults) {
    const input = document.getElementById(id);
    const list = document.getElementById(id + 'List');
    let keyed = false;
    const show = () => {
      const q = input.value.trim().toLowerCase();
      const names = keyed && q ? all.filter((n) => n.toLowerCase().includes(q)) : defaults;
      if (openList && openList !== list) closeOpen();
      list.innerHTML = names.map((n) => '<div role="option">' + n + '</div>').join('');
      list.hidden = !names.length;
      openList = names.length ? list : null;
    };
    input.addEventListener('focus', () => { keyed = false; show(); });
    input.addEventListener('keyup', (e) => { if (e.key.length === 1 || e.key === 'Backspace') { keyed = true; show(); } });
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; input.value = o.textContent; closeOpen(); });
    input.addEventListener('blur', () => {
      if (list.hidden) return;
      const first = list.querySelector('[role=option]');
      if (first && input.value !== first.textContent) input.value = first.textContent;
      closeOpen();
    });
  }
  typeaheadField('make', ['Chevrolet', 'Dodge', 'Ford', 'Harley-Davidson', 'Honda', 'Jeep', 'Ram', 'Toyota'], ['Honda', 'Toyota', 'Ford']);
  typeaheadField('model', ['Accord', 'Civic', 'CR-V', '1500 Classic Express', 'Wagoneer Series III', 'Street Glide SPECIAL', 'Grand Cherokee Altitude X'], ['Accord', 'Civic', 'CR-V']);
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
  // A restored draft: the page opens with another car already in the form
  // (applied at load, before anything else can touch the form).
  (function applyPrefill(p) {
    if (!p) return;
    const setCombo = (id, value) => { const c = document.getElementById(id); c.textContent = value; c.dataset.value = value; };
    setCombo('year', p.year);
    document.getElementById('makeWrap').hidden = false;
    for (const id of ['make', 'model', 'vin', 'mileage', 'description']) document.getElementById(id).value = p[id] || '';
    document.body.dataset.prefilled = '1';
  })(__PREFILL__);
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
    if (url.pathname === '/prefill') {
      prefill = PREFILLS[url.searchParams.get('name')] || null;
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(prefill ? 'prefill on' : 'prefill off');
    }
    if (url.pathname === '/prefill.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(prefill));
    }
    if (/^\/marketplace\/item\/\d+\/?$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Your listing (mock)</title></head><body><h1>Listing 424242 is live (mock)</h1></body></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE.replace('__PREFILL__', JSON.stringify(prefill)));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
