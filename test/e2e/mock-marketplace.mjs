// A stand-in for Facebook's "Create vehicle listing" page, for the end-to-end
// test. Its fields are addressed by role and accessible name the same way
// extension/facebook/formMap.js addresses the real form, so the test proves
// that the find-by-name approach and the fill code work, not that Facebook's
// current page matches (that needs a real, signed-in check; see README).
// The real facebook.com is never automated in tests.
//
// It deliberately mixes control types: a custom combobox (vehicle type),
// native selects, plain inputs, a textarea, a file input, plus the two fields
// the extension must never touch (condition, title status). Only a person
// clicks Publish; the server counts those clicks so the test can prove it.

import http from 'node:http';

let publishClicks = 0;

const opts = (list) => '<option value=""></option>' + list.map((o) => `<option>${o}</option>`).join('');
const COLORS = ['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Grey', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Tan', 'Beige', 'Burgundy', 'Turquoise', 'Off white', 'Other'];
const YEARS = [];
for (let y = 2027; y >= 1990; y -= 1) YEARS.push(String(y));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Create vehicle listing (mock)</title>
<style>body{font:14px system-ui;max-width:640px;margin:20px auto}label{display:block;margin:8px 0}[role=listbox]{border:1px solid #999;padding:4px;width:200px}[role=option]{padding:2px 6px;cursor:pointer}[hidden]{display:none}#vehicleType{border:1px solid #999;padding:4px 8px;width:200px;cursor:pointer}</style>
</head><body>
<h1>Create vehicle listing (mock)</h1>
<p>Add up to 20 photos.</p>
<form onsubmit="return false">
  <label for="photos">Add photos</label>
  <input id="photos" type="file" multiple accept="image/*"> <span id="photoCount">0 photos</span>
  <div>Vehicle type
    <div id="vehicleType" role="combobox" aria-label="Vehicle type" aria-haspopup="listbox" aria-expanded="false" tabindex="0" data-value="">Select a type</div>
    <div id="vehicleTypeList" role="listbox" hidden>
      <div role="option">Car/Truck</div><div role="option">Motorcycle</div><div role="option">Powersport</div><div role="option">RV/Camper</div><div role="option">Trailer</div><div role="option">Boat</div><div role="option">Commercial/Industrial</div><div role="option">Other</div>
    </div>
  </div>
  <label>Year <select id="year">${opts(YEARS)}</select></label>
  <label>Make <input id="make"></label>
  <label>Model <input id="model"></label>
  <label>Mileage <input id="mileage"></label>
  <label>Price <input id="price"></label>
  <label>Body style <select id="bodyStyle">${opts(['Convertible', 'Coupe', 'Hatchback', 'Minivan', 'Truck', 'SUV', 'Sedan', 'Van', 'Wagon', 'Other'])}</select></label>
  <label>Exterior color <select id="exteriorColor">${opts(COLORS)}</select></label>
  <label>Interior color <select id="interiorColor">${opts(COLORS)}</select></label>
  <label>Vehicle condition <select id="condition">${opts(['Excellent', 'Very good', 'Good', 'Fair', 'Poor'])}</select></label>
  <label>Fuel type <select id="fuelType">${opts(['Diesel', 'Electric', 'Gasoline', 'Flex', 'Hybrid', 'Petrol', 'Plug-in hybrid', 'Other'])}</select></label>
  <label>Transmission <select id="transmission">${opts(['Automatic transmission', 'Manual transmission'])}</select></label>
  <label>Title status <select id="titleStatus">${opts(['Clean', 'Rebuilt', 'Salvage', 'Lien', 'Missing'])}</select></label>
  <label>Location <input id="location"></label>
  <label>Description <textarea id="description" rows="10" cols="60"></textarea></label>
  <button type="button" id="publish">Publish</button>
</form>
<script>
  const cb = document.getElementById('vehicleType');
  const list = document.getElementById('vehicleTypeList');
  cb.addEventListener('click', () => { list.hidden = !list.hidden; cb.setAttribute('aria-expanded', String(!list.hidden)); });
  list.addEventListener('click', (e) => {
    const o = e.target.closest('[role=option]');
    if (!o) return;
    cb.textContent = o.textContent;
    cb.dataset.value = o.textContent;
    list.hidden = true;
    cb.setAttribute('aria-expanded', 'false');
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
