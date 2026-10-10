// A stand-in for Facebook's "Create vehicle listing" page, for the end-to-end
// test. Its fields are addressed by role and accessible name the same way
// extension/facebook/formMap.js addresses the real form, so the test proves
// that the find-by-name approach and the fill code work, not that Facebook's
// current page matches (that needs a real, signed-in check; see README).
// The real facebook.com is never automated in tests.
//
// With ?lang=es the same page is drawn in Spanish, <html lang="es"> and all,
// for the test of a Facebook account set to another language: none of its
// accessible names matches an English pattern in formMap.js.
//
// It mimics what the first live run (2026-09-27) showed about the real form:
//   - dropdowns are custom comboboxes whose option list is drawn late
//     (the Year list here takes 2.5 s), and only one popup is open at a time:
//     clicking another dropdown just closes the open one;
//   - the price box reformats what you type ("27163" -> "27,163").
// Above the form sits a top bar (role=banner) with a search box and two menu
// buttons, standing in for Facebook's own: the dry run's report leaves it out.
// It mixes control types (custom comboboxes, native selects, inputs, a
// textarea, a file input, a checkbox). Condition and title status are on it
// too: the website can't tell those, so the extension fills them from the
// dealership's defaults in Settings, the side panel shows them as such, and
// the person checks them before clicking Publish. Only a person clicks
// Publish; the server counts those clicks so the test can prove it.
//
// Beside Publish sit decoys of the other action controls Facebook draws
// around a listing (Next, Post, Save draft, Update, Delete, Mark as sold),
// each as a submit button of the form and as a role=button element, plus
// menu buttons and expandable buttons that the fill code's dropdown finder
// does consider (two of them named Next and Save draft). Nothing may ever touch them: every pointer, mouse, click or
// key event that reaches one, any submit event of the form and any
// form.submit() (the form posts to /form-submitted) is recorded, and GET
// /actions lists what was. The flows assert that list stays empty.
//
// The listing pages (item, edit) carry the real Mark as sold, Delete and
// Update buttons a person clicks during upkeep, and Facebook lands on one
// after Publish. Every post of those forms is logged in order ("sold 424242",
// "delete 424242", "save 515151"), whatever listing it names, and GET
// /listing-actions lists them; GET /listing-state gives every listing as it
// is now, and INITIAL_LISTINGS as it was. The create flows assert the log
// stays empty and the listings unchanged; upkeep asserts the log holds
// exactly the clicks it made as the person.

import http from 'node:http';

let publishClicks = 0;
// What touched a decoy action control or submitted the create form: only ever empty.
const actions = [];
// Like Facebook restoring a saved draft: after GET /prefill?name=honda the
// create page opens already holding another car.
const PREFILLS = {
  none: null,
  honda: { year: '2020', make: 'Honda', model: 'Accord EX-L', vin: '1HGCV1F30LA000000', mileage: '31200', description: 'Low miles, garage kept. Serious buyers only.' },
};
let prefill = null;

const DECOYS = ['Next', 'Post', 'Save draft', 'Update', 'Delete', 'Mark as sold'];
const COLORS = ['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Grey', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Tan', 'Beige', 'Burgundy', 'Turquoise', 'Off white', 'Other'];
const YEARS = [];
for (let y = 2027; y >= 1990; y -= 1) YEARS.push(String(y));

// Spanish, for ?lang=es: the field names, the options of the native selects
// (a select's option text is part of its accessible name as the probe reads
// it, so "Automatic transmission" would otherwise still match "Transmission")
// and the page's own wording. Nothing here matches an English pattern in
// formMap.js, not even the fallback on a field's English label.
const ES = {
  'Create vehicle listing (mock)': 'Crear publicación de vehículo (simulado)',
  'Add up to 20 photos.': 'Añade hasta 20 fotos.',
  'Add photos': 'Añadir fotos',
  photos: 'fotos',
  Select: 'Seleccionar',
  'Vehicle type': 'Tipo de vehículo',
  VIN: 'Número de identificación',
  Year: 'Año',
  Make: 'Marca',
  Model: 'Modelo',
  Mileage: 'Kilometraje',
  Price: 'Precio',
  'Body style': 'Tipo de carrocería',
  'Exterior color': 'Color exterior',
  'Interior color': 'Color interior',
  'Fuel type': 'Tipo de combustible',
  Transmission: 'Transmisión',
  Location: 'Ubicación',
  Description: 'Descripción',
  'Vehicle condition': 'Estado del vehículo',
  'Title status': 'Estado del título',
  'Vehicle details': 'Detalles del vehículo',
  'Include more details to help connect interested buyers to your vehicle.': 'Incluye más detalles para ayudar a los compradores interesados a encontrar tu vehículo.',
  'This vehicle has a clean title.': 'Este vehículo tiene el título limpio.',
  'This vehicle has no significant damage or persistent problems.': 'Este vehículo no tiene daños importantes ni problemas persistentes.',
  Publish: 'Publicar',
  // the decoy action controls
  Next: 'Siguiente', Post: 'Publicar ahora', 'Save draft': 'Guardar borrador', Update: 'Actualizar', Delete: 'Eliminar', 'Mark as sold': 'Marcar como vendido', 'More options': 'Más opciones', 'Publish options': 'Opciones de publicación',
  // the options
  'Car/Truck': 'Coche/Camioneta', Motorcycle: 'Motocicleta', Powersport: 'Vehículo recreativo', 'RV/Camper': 'Autocaravana', Trailer: 'Remolque', Boat: 'Barco', 'Commercial/Industrial': 'Comercial/Industrial', Other: 'Otro',
  Black: 'Negro', Blue: 'Azul', Brown: 'Marrón', Gold: 'Dorado', Green: 'Verde', Grey: 'Gris', Pink: 'Rosa', Purple: 'Morado', Red: 'Rojo', Silver: 'Plateado', Orange: 'Naranja', White: 'Blanco', Yellow: 'Amarillo', Charcoal: 'Carbón', Tan: 'Canela', Burgundy: 'Burdeos', Turquoise: 'Turquesa', 'Off white': 'Blanco roto',
  Convertible: 'Descapotable', Coupe: 'Cupé', Hatchback: 'Compacto', Minivan: 'Monovolumen', Truck: 'Camioneta', SUV: 'Todoterreno', Sedan: 'Sedán', Van: 'Furgoneta', Wagon: 'Familiar',
  Excellent: 'Excelente', 'Very good': 'Muy bueno', Good: 'Bueno', Fair: 'Regular', Poor: 'Malo',
  Diesel: 'Diésel', Electric: 'Eléctrico', Gasoline: 'Gasolina', Hybrid: 'Híbrido', Petrol: 'Nafta', 'Plug-in hybrid': 'Híbrido enchufable',
  'Automatic transmission': 'Transmisión automática', 'Manual transmission': 'Transmisión manual',
  Clean: 'Limpio', Rebuilt: 'Reconstruido', Salvage: 'Siniestrado', Lien: 'Con gravamen', Missing: 'Sin título',
};

// The create-listing page in one language ('en' or 'es'): `t` translates every word it knows.
function page(lang) {
  const t = lang === 'es' ? (s) => ES[s] || s : (s) => s;
  const opts = (list) => '<option value=""></option>' + list.map((o) => `<option>${t(o)}</option>`).join('');
  // A custom dropdown: a combobox control plus a listbox drawn `delay` ms after the click.
  const combo = (id, label, options, delay) =>
    `<div>${t(label)}
    <div id="${id}" role="combobox" aria-label="${t(label)}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}List" tabindex="0" data-value="" data-delay="${delay}">${t('Select')}</div>
    <div id="${id}List" role="listbox" hidden></div>
    <template id="${id}Options">${options.map((o) => `<div role="option">${t(o)}</div>`).join('')}</template>
  </div>`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${t('Create vehicle listing (mock)')}</title>
<style>body{font:14px system-ui;max-width:640px;margin:20px auto}label{display:block;margin:8px 0}[role=listbox]{border:1px solid #999;padding:4px;width:200px;max-height:160px;overflow:auto}[role=option]{padding:2px 6px;cursor:pointer}[hidden]{display:none}[role=combobox]{border:1px solid #999;padding:4px 8px;width:200px;cursor:pointer}</style>
</head><body>
<div role="banner" id="topBar"><input aria-label="Search the top bar"> <div role="button" aria-haspopup="menu" aria-label="Your profile menu" tabindex="0">Profile</div> <div role="button" aria-haspopup="menu" aria-label="Notifications menu" tabindex="0">Notifications</div></div>
<h1>${t('Create vehicle listing (mock)')}</h1>
<p>${t('Add up to 20 photos.')}</p>
<form action="/form-submitted" method="post" onsubmit="return false">
  <label for="photos">${t('Add photos')}</label>
  <input id="photos" type="file" multiple accept="image/*"> <span id="photoCount">0 ${t('photos')}</span>
  ${combo('vehicleType', 'Vehicle type', ['Car/Truck', 'Motorcycle', 'Powersport', 'RV/Camper', 'Trailer', 'Boat', 'Commercial/Industrial', 'Other'], 0)}
  ${combo('year', 'Year', YEARS, 2500)}
  <div id="makeWrap" hidden><label>${t('Make')} <input id="make" role="combobox" aria-autocomplete="list" aria-controls="makeList" autocomplete="off"></label><div id="makeList" role="listbox" hidden></div></div>
  <label>${t('Model')} <input id="model" role="combobox" aria-autocomplete="list" aria-controls="modelList" autocomplete="off"></label><div id="modelList" role="listbox" hidden></div>
  <label>${t('VIN')} <input id="vin"></label>
  <label>${t('Mileage')} <input id="mileage"></label>
  <label>${t('Price')} <input id="price"></label>
  <label>${t('Body style')} <select id="bodyStyle">${opts(['Convertible', 'Coupe', 'Hatchback', 'Minivan', 'Truck', 'SUV', 'Sedan', 'Van', 'Wagon', 'Other'])}</select></label>
  ${combo('exteriorColor', 'Exterior color', COLORS, 300)}
  <label>${t('Interior color')} <select id="interiorColor">${opts(COLORS)}</select></label>
  <label>${t('Vehicle condition')} <select id="condition">${opts(['Excellent', 'Very good', 'Good', 'Fair', 'Poor'])}</select></label>
  <label>${t('Fuel type')} <select id="fuelType">${opts(['Diesel', 'Electric', 'Gasoline', 'Flex', 'Hybrid', 'Petrol', 'Plug-in hybrid', 'Other'])}</select></label>
  <label>${t('Transmission')} <select id="transmission">${opts(['Automatic transmission', 'Manual transmission'])}</select></label>
  <label>${t('Title status')} <select id="titleStatus">${opts(['Clean', 'Rebuilt', 'Salvage', 'Lien', 'Missing'])}</select></label>
  <div><b>${t('Vehicle details')}</b><div>${t('Include more details to help connect interested buyers to your vehicle.')}</div>
    <div><div><b>${t('This vehicle has a clean title.')}</b><div>${t('This vehicle has no significant damage or persistent problems.')}</div></div><input type="checkbox" id="cleanTitle"></div>
  </div>
  <label>${t('Location')} <input id="location" role="combobox" aria-autocomplete="list" aria-controls="locationList" autocomplete="off"></label>
  <div id="locationList" role="listbox" hidden></div>
  <label>${t('Description')} <textarea id="description" rows="10" cols="60"></textarea></label>
  <button type="button" id="publish">${t('Publish')}</button>
  <div id="decoys">
    ${DECOYS.map((d) => `<button data-decoy="${d} (button)">${t(d)}</button> <div role="button" tabindex="0" data-decoy="${d} (role=button)">${t(d)}</div>`).join('\n    ')}
    <div role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false" data-decoy="More options (menu button)">${t('More options')}</div>
    <button type="button" aria-expanded="false" data-decoy="Publish options (expandable)">${t('Publish options')}</button>
    <div role="button" tabindex="0" aria-expanded="false" data-decoy="Next (expandable)">${t('Next')}</div>
    <button type="button" aria-haspopup="menu" aria-expanded="false" data-decoy="Save draft (menu button)">${t('Save draft')}</button>
  </div>
</form>
<script>
  // The decoys: anything that reaches one, or submits the form, is reported.
  const report = (what) => fetch('/action', { method: 'POST', body: what, keepalive: true });
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup']) {
    document.addEventListener(type, (e) => {
      const d = e.target && e.target.closest ? e.target.closest('[data-decoy]') : null;
      if (d) report(d.dataset.decoy + ' ' + type + (e.key ? ' ' + e.key : ''));
    }, true);
  }
  document.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); report('form submit event'); });
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
  // Like the real form: Escape pressed in the location box clears it.
  loc.addEventListener('keydown', (e) => { if (e.key === 'Escape') { loc.value = ''; closeOpen(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpen(); });
  document.addEventListener('mousedown', (e) => { if (openList && !e.target.closest('[role=listbox],[role=combobox]')) closeOpen(); });
  // A restored draft: the page opens with another car already in the form,
  // or (late mode) the draft lands a few seconds after load, over whatever
  // is there by then, like the live form does.
  (function schedulePrefill(p) {
    if (!p) return;
    const apply = () => {
      const setCombo = (id, value) => { const c = document.getElementById(id); c.textContent = value; c.dataset.value = value; };
      setCombo('year', p.year);
      document.getElementById('makeWrap').hidden = false;
      for (const id of ['make', 'model', 'vin', 'mileage', 'description']) document.getElementById(id).value = p[id] || '';
      document.body.dataset.prefilled = '1';
    };
    if (p.late) setTimeout(apply, Number(p.late));
    else apply();
  })(__PREFILL__);
  // The price box reformats digits with thousands separators, like the real one.
  document.getElementById('price').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\\D/g, '');
    e.target.value = digits ? Number(digits).toLocaleString('en-US') : '';
  });
  let photos = 0;
  document.getElementById('photos').addEventListener('change', (e) => {
    photos += e.target.files.length;
    document.getElementById('photoCount').textContent = photos + ' ' + ${JSON.stringify(t('photos'))};
  });
  // Only a person clicks this. The extension has no code path to it.
  document.getElementById('publish').addEventListener('click', async () => {
    await fetch('/published', { method: 'POST' });
    location.href = '/marketplace/item/424242/';
  });
</script></body></html>`;
}

// Listings the person has published, for the upkeep pages: id -> { title, price, vin, sold, deleted }.
// 616161 is another listing of the same year, make and model as 515151 (a
// different trim), and 434343 a second unit of 424242's car at the same
// price, told apart only by the VIN its description carries: upkeep must
// never take one for the other.
const listings = {
  424242: { title: '2019 Ram 1500 Classic Express', price: 27163, vin: '1C6RR7FT0KS643289', sold: false, deleted: false },
  434343: { title: '2019 Ram 1500 Classic Express', price: 27163, vin: '1C6RR7FT0KS000434', sold: false, deleted: false },
  515151: { title: '2022 Jeep Wagoneer Series III', price: 38383, vin: '1C4SJVDT7NS142834', sold: false, deleted: false },
  616161: { title: '2022 Jeep Wagoneer Series II', price: 41500, vin: '1C4SJVBT0NS000616', sold: false, deleted: false },
};
export const INITIAL_LISTINGS = Object.freeze(structuredClone(listings));
// Every Mark as sold, Delete and Update posted to the listing pages, in order.
const listingActions = [];

// Like Marketplace's Your listings: every listing's name, price and status on one page.
const yourListingsPage = () => `<!doctype html><html><head><meta charset="utf-8"><title>Your listings (mock)</title></head><body>
<h1>Your listings</h1>
<ul>${Object.entries(listings).filter(([, l]) => !l.deleted).map(([id, l]) => `<li><a href="/marketplace/item/${id}/">${l.title}</a> <span>$${l.price.toLocaleString('en-US')}</span> <span>${l.sold ? 'Sold' : 'Active'}</span></li>`).join('')}</ul>
</body></html>`;

// Like a real listing page: the description is prose (here it even contains
// the word "sold"), the status badge is a short label of its own, the
// controls are buttons, and a "Sold" filter tab sits at the top.
const itemPage = (id, l) => `<!doctype html><html><head><meta charset="utf-8"><title>${l.title} (mock listing)</title></head><body>
<div role="tablist"><span role="tab">Active</span><span role="tab">Sold</span></div>
<h1>${l.title}</h1>
${l.deleted ? '<p>This content isn\'t available right now.</p>' : `<p class="price">$${l.price.toLocaleString('en-US')}</p>${l.sold ? '<p class="badge">Sold</p>' : ''}
<p class="description">Sold as-is with the remaining factory warranty. Ask for Roger, sales consultant at the dealership. VIN ${l.vin}.</p>
<p><a href="/marketplace/edit/${id}/">Edit listing</a></p>
<form method="post" action="/marketplace/item/${id}/sold"><button type="submit">Mark as sold</button></form>
<form method="post" action="/marketplace/item/${id}/delete"><button type="submit">Delete</button></form>`}
</body></html>`;

const editPage = (id, l) => `<!doctype html><html><head><meta charset="utf-8"><title>Edit listing (mock)</title></head><body>
<h1>Edit listing: ${l.title}</h1>
<form method="post" action="/marketplace/edit/${id}/save">
  <label>Price <input id="price" name="price" value="${l.price}"></label>
  <label>Description <textarea name="description">unchanged</textarea></label>
  <button type="submit" id="update">Update</button>
</form>
</body></html>`;

export function startMockMarketplace(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/published') {
      publishClicks += 1;
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'POST' && (url.pathname === '/action' || url.pathname === '/form-submitted')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        actions.push(url.pathname === '/action' ? raw.slice(0, 200) : 'form.submit()');
        res.writeHead(url.pathname === '/action' ? 204 : 200, { 'content-type': 'text/html' });
        res.end(url.pathname === '/action' ? undefined : '<!doctype html><title>Form submitted (mock)</title><h1>The form was submitted</h1>');
      });
      return;
    }
    if (url.pathname === '/actions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(actions));
    }
    // ---- the person's published listings, and the actions only they take ----
    const item = /^\/marketplace\/item\/(\d+)\/(sold|delete)$/.exec(url.pathname);
    if (req.method === 'POST' && item) listingActions.push(`${item[2]} ${item[1]}`);
    if (req.method === 'POST' && item && listings[item[1]]) {
      listings[item[1]][item[2] === 'sold' ? 'sold' : 'deleted'] = true;
      res.writeHead(303, { location: `/marketplace/item/${item[1]}/` });
      return res.end();
    }
    const save = /^\/marketplace\/edit\/(\d+)\/save$/.exec(url.pathname);
    if (req.method === 'POST' && save) listingActions.push(`save ${save[1]}`);
    if (req.method === 'POST' && save && listings[save[1]]) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const price = Number(new URLSearchParams(raw).get('price'));
        if (price > 0) listings[save[1]].price = price;
        res.writeHead(303, { location: `/marketplace/item/${save[1]}/` });
        res.end();
      });
      return;
    }
    const edit = /^\/marketplace\/edit\/(\d+)\/?$/.exec(url.pathname);
    if (edit && listings[edit[1]]) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(editPage(edit[1], listings[edit[1]]));
    }
    if (/^\/marketplace\/you\/selling\/?$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(yourListingsPage());
    }
    if (url.pathname === '/listing-state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(listings));
    }
    if (url.pathname === '/listing-actions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(listingActions));
    }
    const known = /^\/marketplace\/item\/(\d+)\/?$/.exec(url.pathname);
    if (known && listings[known[1]]) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(itemPage(known[1], listings[known[1]]));
    }
    if (url.pathname === '/publish-count') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(String(publishClicks));
    }
    if (url.pathname === '/prefill') {
      const base = PREFILLS[url.searchParams.get('name')] || null;
      const late = Number(url.searchParams.get('late') || 0);
      prefill = base ? { ...base, late } : null;
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(prefill ? `prefill on${late ? ' (late ' + late + 'ms)' : ''}` : 'prefill off');
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
    res.end(page(url.searchParams.get('lang') === 'es' ? 'es' : 'en').replace('__PREFILL__', JSON.stringify(prefill)));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
