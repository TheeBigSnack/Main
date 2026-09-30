// The second sample dealership, "Example Auto Outlet" (Springfield, OH): its
// lot and every page of its website. Unlike the first sample (demo/site/,
// where an inventory search service sits behind the page), this website
// publishes the standard vehicle data search engines read: schema.org Car,
// Vehicle and Offer markup on each car's own page, as JSON-LD (on its own,
// in an @graph, or next to a carousel of other cars) or as microdata, found
// from a used-inventory list page with rel=next pagination, a sitemap and a
// robots.txt. It is written from the public schema.org definitions and
// Google's vehicle listing documentation, not copied from any website, so it
// shows nothing about how any named platform marks up its cars.
//
// Every value is made up: the dealership, its address, the stock numbers,
// the mileages, the prices, the descriptions and the VINs (which spell SAMPL
// and pass extension/src/vin.js's check digit and model year checks, and its
// manufacturer check for every make it knows).
//
// Plain script, no imports: the sample page (index.html), the sandbox page,
// test/demo.test.js and the end-to-end mock server
// (test/e2e/mock-standard-site.mjs) all load it, the last two through
// node:vm. It defines window.LOT_SYNC_STANDARD; respond(url, scenario, site)
// answers one address the way the website's server would, and the two
// address schemes are pathSite(origin) (a real server: /used-vehicles/,
// /inventory/<car>/) and hashSite(base) (a static host: index.html#/...).
//
// The lot on day 1, 4 cars to a list page:
//   ready to post   Civic, F-150, Escape (microdata only), Accord, Sorento
//                   (its page has a carousel of other cars), RAV4 (certified)
//   not ready       Malibu: its markup says $14,995 but the page shows
//                   $15,495, and a price the page does not show is no price;
//                   Wrangler: no photos yet
//   needs a look    Outback: 12 miles on a used car
//   never a car     a trade-in trailer, marked up as a Vehicle with no
//                   odometer: it must never be offered as a car
//   not on the list a new Telluride: its page exists, and the Sorento's
//                   carousel links to it
// Day 2: the Accord sold (its page answers 404, or as the scenario asks a
// 301 to the list or a 200 "no longer available" page), the Civic dropped
// $1,000, the Wrangler got photos and a Tucson arrived. { name: 'day2',
// sold, dropped } aims the sale and the price drop at other cars.

(function (root) {
  'use strict';

  const DEALER = Object.freeze({ name: 'Example Auto Outlet', street: '200 Sample Avenue', city: 'Springfield', state: 'OH', zip: '45505', phone: '(555) 010-0200' });
  const PER_PAGE = 4;
  const SCHEMA = 'https://schema.org/';
  // On every car, so the description writer finds it lot-wide and strips it.
  const DISCLAIMER = 'Example Auto Outlet prices exclude tax, title and registration. Sample listing; not a real vehicle.';

  // Each car in a short form (the shape of demo/site/inventory.js), plus how
  // its page is marked up. price is the price in the markup; shownPrice, when
  // set, is the different one the page shows.
  const CARS = [
    {
      key: 'civic', vin: '2HGSAMPL1KH000201', stock: 'EA2001', type: 'Used', year: 2019, make: 'Honda', model: 'Civic', trim: 'EX', mileage: 41230, price: 19995,
      photos: 3, carfax: true, markup: 'jsonld',
      exterior: 'Lunar Silver Metallic', interior: 'Gray', body: 'Sedan', drivetrain: 'FWD', engine: '1.5L Turbo 4-Cylinder', transmission: 'CVT', fuel: 'Gasoline',
      features: ['Sunroof', 'Backup Camera', 'Apple CarPlay', 'Heated Front Seats', 'Bluetooth', 'Remote Start'],
      narrative: 'This Civic EX has the 1.5L Turbo 4-Cylinder, a CVT and a sunroof.',
    },
    {
      key: 'f150', vin: '1FTSAMPL0KF000204', stock: 'EA2002', type: 'Used', year: 2019, make: 'Ford', model: 'F-150', trim: 'XLT', mileage: 58112, price: 31495,
      photos: 3, carfax: true, markup: 'graph',
      exterior: 'Oxford White', interior: 'Medium Earth Gray', body: 'Pickup Truck', drivetrain: '4WD', engine: '3.5L EcoBoost V6', transmission: '10-Speed Automatic', fuel: 'Gasoline',
      features: ['4WD', 'Tow Package', 'Backup Camera', 'Apple CarPlay', 'Bluetooth', 'Keyless Entry'],
      narrative: 'An F-150 XLT SuperCrew with the 3.5L EcoBoost V6, 4WD and the tow package.',
    },
    {
      // the markup price is not the one the page shows
      key: 'malibu', vin: '1G1SAMPL0HF000207', stock: 'EA2003', type: 'Used', year: 2017, make: 'Chevrolet', model: 'Malibu', trim: 'LT', mileage: 71344, price: 14995, shownPrice: 15495,
      photos: 3, carfax: false, markup: 'jsonld',
      exterior: 'Summit White', interior: 'Jet Black', body: 'Sedan', drivetrain: 'FWD', engine: '1.5L Turbo 4-Cylinder', transmission: '6-Speed Automatic', fuel: 'Gasoline',
      features: ['Backup Camera', 'Apple CarPlay', 'Bluetooth', 'Remote Start', 'Keyless Entry'],
      narrative: '',
    },
    {
      key: 'escape', vin: '1FMSAMPL5JU000205', stock: 'EA2004', type: 'Used', year: 2018, make: 'Ford', model: 'Escape', trim: 'SE', mileage: 52110, price: 16495,
      photos: 3, carfax: true, markup: 'microdata',
      exterior: 'Magnetic Metallic', interior: 'Charcoal Black', body: 'SUV', drivetrain: 'AWD', engine: '1.5L EcoBoost 4-Cylinder', transmission: '6-Speed Automatic', fuel: 'Gasoline',
      features: ['AWD', 'Backup Camera', 'Bluetooth', 'Heated Front Seats', 'Keyless Entry'],
      narrative: 'An Escape SE with AWD and heated front seats.',
    },
    {
      key: 'accord', vin: '1HGSAMPL3LA000202', stock: 'EA2005', type: 'Used', year: 2020, make: 'Honda', model: 'Accord', trim: 'Sport', mileage: 29870, price: 23495,
      photos: 3, carfax: true, markup: 'jsonld',
      exterior: 'Crystal Black Pearl', interior: 'Black', body: 'Sedan', drivetrain: 'FWD', engine: '1.5L Turbo 4-Cylinder', transmission: 'CVT', fuel: 'Gasoline',
      features: ['Apple CarPlay', 'Android Auto', 'Backup Camera', 'Blind Spot Monitor', 'Bluetooth', 'Remote Start'],
      narrative: 'An Accord Sport with the 1.5L Turbo 4-Cylinder, a CVT and blind spot monitoring.',
    },
    {
      // its page lists other cars in a carousel, one of them new
      key: 'sorento', vin: '5XYSAMPL0MG000206', stock: 'EA2006', type: 'Used', year: 2021, make: 'Kia', model: 'Sorento', trim: 'LX', mileage: 35780, price: 25995,
      photos: 3, carfax: true, markup: 'carousel', similar: ['accord', 'rav4', 'telluride'],
      exterior: 'Everlasting Silver', interior: 'Black', body: 'SUV', drivetrain: 'AWD', engine: '2.5L 4-Cylinder', transmission: '8-Speed Automatic', fuel: 'Gasoline',
      features: ['AWD', 'Third Row Seating', 'Apple CarPlay', 'Backup Camera', 'Blind Spot Monitor', 'Keyless Entry'],
      narrative: '',
    },
    {
      // no photos on day 1 (Not ready); they arrive on day 2 (Just became ready)
      key: 'wrangler', vin: '1C4SAMPL3GL000208', stock: 'EA2007', type: 'Used', year: 2016, make: 'Jeep', model: 'Wrangler', trim: 'Sport', mileage: 84905, price: 22995,
      photos: 0, carfax: false, markup: 'jsonld',
      exterior: 'Firecracker Red', interior: 'Black', body: 'SUV', drivetrain: '4WD', engine: '3.6L V6', transmission: '6-Speed Manual', fuel: 'Gasoline',
      features: ['4WD', 'Tow Package', 'Bluetooth', 'Cruise Control'],
      narrative: '',
    },
    {
      // a trade-in trailer on the used list: schema.org's general Vehicle, no odometer
      key: 'trailer', kind: 'trailer', vin: '16VSAMPL2GB000209', stock: 'EA2008', type: 'Used', year: 2016, make: 'Big Tex', model: '14ET', trim: 'Dump Trailer', mileage: null, price: 6995,
      photos: 3, carfax: false, markup: 'jsonld',
      exterior: 'Black', interior: '', body: 'Trailer', drivetrain: '', engine: '', transmission: '', fuel: '',
      features: ['Tandem Axle', 'Hydraulic Dump Bed', 'Spare Tire'],
      narrative: 'A tandem-axle dump trailer that came to us on trade.',
    },
    {
      key: 'rav4', vin: '2T3SAMPL1NW000203', stock: 'EA2009', type: 'Certified Used', year: 2022, make: 'Toyota', model: 'RAV4', trim: 'XLE', mileage: 18406, price: 29995,
      photos: 3, carfax: true, markup: 'jsonld',
      exterior: 'Blueprint', interior: 'Black', body: 'SUV', drivetrain: 'AWD', engine: '2.5L 4-Cylinder', transmission: '8-Speed Automatic', fuel: 'Gasoline',
      features: ['AWD', 'Apple CarPlay', 'Android Auto', 'Blind Spot Monitor', 'Heated Front Seats', 'Backup Camera'],
      narrative: 'A certified RAV4 XLE with AWD.',
    },
    {
      // 12 miles on a used car: the website's details don't add up (Needs a look)
      key: 'outback', vin: '4S4SAMPL6S3000210', stock: 'EA2010', type: 'Used', year: 2025, make: 'Subaru', model: 'Outback', trim: 'Premium', mileage: 12, price: 34995,
      photos: 3, carfax: false, markup: 'jsonld',
      exterior: 'Autumn Green Metallic', interior: 'Slate Black', body: 'Wagon', drivetrain: 'AWD', engine: '2.5L 4-Cylinder', transmission: 'CVT', fuel: 'Gasoline',
      features: ['AWD', 'Apple CarPlay', 'Heated Front Seats', 'Backup Camera', 'Blind Spot Monitor'],
      narrative: '',
    },
    {
      // new: not on the used list; the Sorento's carousel links to its page
      key: 'telluride', vin: '5XYSAMPL2VG000211', stock: 'EA3001', type: 'New', year: 2027, make: 'Kia', model: 'Telluride', trim: 'EX', mileage: 5, price: 42995, onList: false,
      photos: 3, carfax: false, markup: 'jsonld',
      exterior: 'Wolf Gray', interior: 'Black', body: 'SUV', drivetrain: 'AWD', engine: '3.8L V6', transmission: '8-Speed Automatic', fuel: 'Gasoline',
      features: ['AWD', 'Third Row Seating', 'Apple CarPlay', 'Heated Front Seats'],
      narrative: '',
    },
    {
      // the day-2 arrival
      key: 'tucson', vin: '5NMSAMPLXMU000212', stock: 'EA2011', type: 'Used', year: 2021, make: 'Hyundai', model: 'Tucson', trim: 'SEL', mileage: 30655, price: 21995, day2Only: true,
      photos: 3, carfax: true, markup: 'jsonld',
      exterior: 'Stellar Silver', interior: 'Gray', body: 'SUV', drivetrain: 'AWD', engine: '2.5L 4-Cylinder', transmission: '8-Speed Automatic', fuel: 'Gasoline',
      features: ['AWD', 'Apple CarPlay', 'Blind Spot Monitor', 'Heated Front Seats', 'Keyless Entry'],
      narrative: '',
    },
  ];

  const byKey = Object.fromEntries(CARS.map((c) => [c.key, c]));
  const VINS = Object.fromEntries(CARS.map((c) => [c.key, c.vin]));

  // What day 2 changes when nothing else is asked. soldPage is how the sold
  // car's old page answers: '404', '301' (to the used list) or '200' (a page
  // that says the car is no longer available).
  const DAY2_DEFAULTS = Object.freeze({ sold: VINS.accord, dropped: VINS.civic, drop: 1000, gotPhotos: VINS.wrangler, arrival: VINS.tucson, soldPage: '404' });
  const SOLD_PAGES = Object.freeze(['404', '301', '200']);
  // The cars the sandbox aims day 2 at when fewer than two are posted.
  const DAY2_ORDER = Object.freeze([VINS.accord, VINS.civic, VINS.f150, VINS.rav4]);

  const DRIVES = { AWD: 'AllWheelDriveConfiguration', '4WD': 'FourWheelDriveConfiguration', FWD: 'FrontWheelDriveConfiguration', RWD: 'RearWheelDriveConfiguration' };
  const condition = (c) => (c.type === 'New' ? 'New' : c.type === 'Certified Used' ? 'Certified Pre-Owned' : 'Used');
  const plainName = (c) => [c.year, c.make, c.model, c.trim].filter(Boolean).join(' ');
  // The website's own title for the car, its condition first, the way dealer websites title a car's page.
  const nameOf = (c) => `${condition(c)} ${plainName(c)}`;
  const slugOf = (c) => `${c.type === 'New' ? 'new' : c.type === 'Certified Used' ? 'certified-used' : 'used'}-${plainName(c)}-${c.vin}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const vehicleRoute = (c) => `/inventory/${slugOf(c)}/`;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  // JSON-LD inside a script element: a "<" in a value must not close the element.
  const ld = (value) => JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
  const money = (n) => '$' + Number(n).toLocaleString('en-US');
  const miles = (n) => Number(n).toLocaleString('en-US') + ' miles';

  // ---------- the two address schemes ----------

  // A real server: /used-vehicles/?page=2, /inventory/<car>/, /photos/<car>-1.png.
  function pathSite(origin, { carfax = null } = {}) {
    const o = new URL(String(origin)).origin;
    return {
      address: (route) => o + route,
      photo: (c, n) => `${o}/photos/${c.key}-${n}.png`,
      carfax,
      route(url) {
        let u;
        try { u = new URL(String(url), o + '/'); } catch (e) { return null; }
        if (u.origin !== o) return null;
        const page = u.searchParams.get('page');
        return u.pathname + (page && /^\/(used|new)-vehicles\/?$/.test(u.pathname) ? '?page=' + page : '');
      },
    };
  }

  // A static host, which serves files and nothing else: the website is one
  // page (index.html) whose routes follow "#/", the way the first sample
  // addresses its cars, and the page answers its own requests for them.
  // robots.txt sits at the host's root, where robots.txt always sits.
  function hashSite(base) {
    const b = new URL('./', String(base)).href;
    const home = new URL('index.html', b).href;
    const origin = new URL(b).origin;
    return {
      address(route) {
        if (route === '/robots.txt') return origin + '/robots.txt';
        if (route === '/sitemap.xml') return b + 'sitemap.xml';
        if (route === '/') return home;
        return home + '#' + route;
      },
      photo: (c, n) => `${b}photos/${c.key}-${n}.svg`,
      carfax: null, // nothing in the sandbox points at another website
      route(url) {
        let u;
        try { u = new URL(String(url), home); } catch (e) { return null; }
        if (u.origin !== origin) return null;
        if (u.pathname === '/robots.txt') return '/robots.txt';
        if (u.pathname === '/sitemap.xml' || u.href.split('#')[0] === b + 'sitemap.xml') return '/sitemap.xml';
        if (u.pathname !== new URL(b).pathname && u.pathname !== new URL(home).pathname) return null;
        return /^#\//.test(u.hash) ? u.hash.slice(1) : '/'; // an in-page anchor is the page itself
      },
    };
  }

  const listAddress = (site, n) => site.address(n > 1 ? `/used-vehicles/?page=${n}` : '/used-vehicles/');
  const photosOf = (site, c) => Array.from({ length: c.photos }, (_, i) => site.photo(c, i + 1));

  // ---------- the scenario ----------

  const readScenario = (scenario) => (typeof scenario === 'string' ? { name: scenario } : scenario && typeof scenario === 'object' ? scenario : { name: 'day1' });
  const usedCar = (vin) => CARS.find((c) => c.vin === String(vin || '').toUpperCase() && c.onList !== false && !c.day2Only);

  // Which car sells and which one drops its price on day 2.
  function day2Plan(scenario) {
    const s = readScenario(scenario);
    const sold = (usedCar(s.sold) || byKey.accord).vin;
    const priced = (c) => c && c.price && c.vin !== sold;
    const dropped = priced(usedCar(s.dropped)) ? usedCar(s.dropped) : priced(byKey.civic) ? byKey.civic : CARS.find((c) => c.onList !== false && !c.day2Only && priced(c));
    const soldPage = SOLD_PAGES.includes(String(s.soldPage)) ? String(s.soldPage) : DAY2_DEFAULTS.soldPage;
    return { ...DAY2_DEFAULTS, sold, dropped: dropped.vin, soldPage };
  }

  /**
   * The used cars on the list for a scenario, in list order, each with that
   * day's price and photo count.
   * @param {'day1'|'day2'|{name, sold?, dropped?, soldPage?}} scenario
   */
  function lot(scenario) {
    const s = readScenario(scenario);
    const used = CARS.filter((c) => c.onList !== false);
    if (s.name !== 'day2') return used.filter((c) => !c.day2Only).map((c) => ({ ...c }));
    const d = day2Plan(s);
    return used.filter((c) => c.vin !== d.sold && (!c.day2Only || c.vin === d.arrival)).map((c) => {
      if (c.vin === d.dropped) return { ...c, price: c.price - d.drop, ...(c.shownPrice ? { shownPrice: c.shownPrice - d.drop } : {}) };
      if (c.vin === d.gotPhotos) return { ...c, photos: 3 };
      return { ...c };
    });
  }

  // Every car with a page on the website that day: the used lot and the new cars.
  const onWebsite = (scenario) => [...lot(scenario), ...CARS.filter((c) => c.onList === false).map((c) => ({ ...c }))];

  // What day 2 does, in names: the sandbox page's status line.
  function describeDay2(scenario) {
    const d = day2Plan(scenario);
    const named = (vin) => { const c = CARS.find((x) => x.vin === vin); return c ? plainName(c) : ''; };
    return { sold: named(d.sold), dropped: named(d.dropped), drop: d.drop, gotPhotos: named(d.gotPhotos), arrived: named(d.arrival) };
  }

  // ---------- markup ----------

  const dealerNode = (site) => ({
    '@context': 'https://schema.org',
    '@type': 'AutoDealer',
    name: DEALER.name,
    url: site.address('/'),
    telephone: DEALER.phone,
    address: { '@type': 'PostalAddress', streetAddress: DEALER.street, addressLocality: DEALER.city, addressRegion: DEALER.state, postalCode: DEALER.zip, addressCountry: 'US' },
  });

  const descriptionOf = (c) => `${c.narrative || `Recent arrival with ${c.features.slice(0, 3).join(', ')}.`} ${DISCLAIMER}`;
  const drive = (c) => (DRIVES[c.drivetrain] ? SCHEMA + DRIVES[c.drivetrain] : undefined);

  // The car as Google's vehicle listing documentation describes it: a Car
  // (with Product, which the documentation pairs with it), or schema.org's
  // general Vehicle for a trailer, and its Offer.
  function carNode(site, c) {
    const url = site.address(vehicleRoute(c));
    const node = {
      '@context': 'https://schema.org',
      '@type': c.kind === 'trailer' ? 'Vehicle' : ['Product', 'Car'],
      name: nameOf(c),
      url,
      vehicleIdentificationNumber: c.vin,
      sku: c.stock,
      vehicleModelDate: String(c.year),
      brand: { '@type': 'Brand', name: c.make },
      model: c.model,
      vehicleConfiguration: c.trim,
      itemCondition: SCHEMA + (c.type === 'New' ? 'NewCondition' : 'UsedCondition'),
    };
    if (typeof c.mileage === 'number') node.mileageFromOdometer = { '@type': 'QuantitativeValue', value: c.mileage, unitCode: 'SMI' };
    if (c.exterior) node.color = c.exterior;
    if (c.interior) node.vehicleInteriorColor = c.interior;
    node.bodyType = c.body;
    if (drive(c)) node.driveWheelConfiguration = drive(c);
    if (c.engine) node.vehicleEngine = { '@type': 'EngineSpecification', name: c.engine };
    if (c.transmission) node.vehicleTransmission = c.transmission;
    if (c.fuel) node.fuelType = c.fuel;
    if (c.photos) node.image = photosOf(site, c);
    node.description = descriptionOf(c);
    node.additionalProperty = c.features.map((f) => ({ '@type': 'PropertyValue', name: f, value: true }));
    node.offers = { '@type': 'Offer', price: c.price, priceCurrency: 'USD', availability: SCHEMA + 'InStock', url, seller: { '@type': 'AutoDealer', name: DEALER.name } };
    return node;
  }

  // The same car in an @graph: the page, the dealer, the car and its offer,
  // tied together by @id, with the price written as text.
  function graphNode(site, c) {
    const url = site.address(vehicleRoute(c));
    const { '@context': context, offers, ...car } = carNode(site, c);
    const dealer = { ...dealerNode(site), '@id': site.address('/') + '#dealer' };
    delete dealer['@context'];
    return {
      '@context': context,
      '@graph': [
        { '@type': 'WebPage', '@id': url + '#webpage', url, name: nameOf(c), mainEntity: { '@id': url + '#vehicle' } },
        dealer,
        { ...car, '@type': 'Car', '@id': url + '#vehicle', offers: { '@id': url + '#offer' } },
        { ...offers, '@id': url + '#offer', price: String(offers.price), seller: { '@id': site.address('/') + '#dealer' } },
      ],
    };
  }

  // Cars shown next to another car ("Similar vehicles"), each with its own address and offer.
  function carouselNode(site, cars) {
    return {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Similar vehicles',
      itemListElement: cars.map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'Car',
          name: nameOf(c),
          url: site.address(vehicleRoute(c)),
          vehicleIdentificationNumber: c.vin,
          vehicleModelDate: String(c.year),
          brand: { '@type': 'Brand', name: c.make },
          model: c.model,
          vehicleConfiguration: c.trim,
          itemCondition: SCHEMA + (c.type === 'New' ? 'NewCondition' : 'UsedCondition'),
          ...(c.photos ? { image: photosOf(site, c)[0] } : {}),
          offers: { '@type': 'Offer', price: c.shownPrice || c.price, priceCurrency: 'USD', availability: SCHEMA + 'InStock' },
        },
      })),
    };
  }

  // A list page's summary of its cars: each car's address, name, VIN and
  // condition. The price, the mileage and the photos are on the car's own page.
  function listNode(site, cars, { name, first, total }) {
    return {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name,
      numberOfItems: total,
      itemListElement: cars.map((c, i) => {
        const url = site.address(vehicleRoute(c));
        return {
          '@type': 'ListItem',
          position: first + i,
          url,
          item: { '@type': c.kind === 'trailer' ? 'Vehicle' : 'Car', name: nameOf(c), url, vehicleIdentificationNumber: c.vin, itemCondition: SCHEMA + (c.type === 'New' ? 'NewCondition' : 'UsedCondition') },
        };
      }),
    };
  }

  // The same car as microdata, and nothing else on the page carries markup for it.
  function microdataCar(site, c) {
    const meta = (prop, value) => (value === undefined || value === null || value === '' ? '' : `<meta itemprop="${prop}" content="${esc(value)}">`);
    const url = site.address(vehicleRoute(c));
    return `<article class="car" itemscope itemtype="${SCHEMA}Car">
  <h1 itemprop="name">${esc(nameOf(c))}</h1>
  <link itemprop="url" href="${esc(url)}">
  ${meta('vehicleIdentificationNumber', c.vin)}${meta('sku', c.stock)}${meta('vehicleModelDate', c.year)}
  <span itemprop="brand" itemscope itemtype="${SCHEMA}Brand">${meta('name', c.make)}</span>
  ${meta('model', c.model)}${meta('vehicleConfiguration', c.trim)}${meta('itemCondition', SCHEMA + 'UsedCondition')}
  ${typeof c.mileage === 'number' ? `<span itemprop="mileageFromOdometer" itemscope itemtype="${SCHEMA}QuantitativeValue">${meta('value', c.mileage)}${meta('unitCode', 'SMI')}</span>` : ''}
  ${meta('color', c.exterior)}${meta('vehicleInteriorColor', c.interior)}${meta('bodyType', c.body)}${meta('driveWheelConfiguration', drive(c))}
  ${c.engine ? `<span itemprop="vehicleEngine" itemscope itemtype="${SCHEMA}EngineSpecification">${meta('name', c.engine)}</span>` : ''}
  ${meta('vehicleTransmission', c.transmission)}${meta('fuelType', c.fuel)}
  ${photoStrip(site, c, true)}
  <p class="price" itemprop="offers" itemscope itemtype="${SCHEMA}Offer">Our price <b>${money(c.shownPrice || c.price)}</b>${meta('price', c.price)}${meta('priceCurrency', 'USD')}${meta('availability', SCHEMA + 'InStock')}<span itemprop="seller" itemscope itemtype="${SCHEMA}AutoDealer">${meta('name', DEALER.name)}</span></p>
  ${specs(c)}
  <p class="desc" itemprop="description">${esc(descriptionOf(c))}</p>
  <ul class="features">${c.features.map((f) => `<li itemprop="additionalProperty" itemscope itemtype="${SCHEMA}PropertyValue"><span itemprop="name">${esc(f)}</span>${meta('value', 'true')}</li>`).join('')}</ul>
</article>`;
  }

  // ---------- pages ----------

  const STYLE = `
    :root { --ink: #1c1f1d; --muted: #5f6661; --line: #e2e5e1; --brand: #7c2d12; --accent: #b45309; --bg: #f6f7f5; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; }
    .sample { background: #fff4dc; color: #8a5300; padding: 6px 16px; font-size: 12px; text-align: center; border-bottom: 1px solid #f1dba8; }
    header.site { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--line); }
    header.site .logo { font-weight: 800; font-size: 20px; color: var(--brand); }
    header.site .logo small { display: block; font-weight: 500; font-size: 11px; color: var(--muted); }
    header.site nav a { margin-left: 16px; color: var(--ink); text-decoration: none; font-weight: 600; }
    main { max-width: 1100px; margin: 0 auto; padding: 16px 20px 32px; }
    h1 { font-size: 20px; margin: 4px 0 6px; }
    .count, .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
    .card { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .card .photo { display: flex; aspect-ratio: 4 / 3; background: var(--bg); align-items: center; justify-content: center; color: var(--muted); font-size: 12px; }
    .card img, .photos img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .card .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 3px; }
    .card .type { font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); }
    .card .name { font-weight: 700; color: var(--ink); text-decoration: none; }
    .price { font-size: 18px; font-weight: 800; color: var(--brand); }
    .photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-width: 720px; margin: 8px 0; }
    .photos.none { display: block; color: var(--muted); }
    .specs { columns: 2; max-width: 620px; }
    .pages a { margin-right: 10px; }
    .carousel { margin-top: 24px; border-top: 1px solid var(--line); padding-top: 12px; }
    footer { border-top: 1px solid var(--line); padding: 14px 20px; color: var(--muted); font-size: 12px; }
  `;

  // One page as its head and body, so a page can also be drawn into the live
  // document (the sandbox's sample page does that).
  function layout(site, { title, ogTitle = '', canonical = '', prev = '', next = '', blocks = [], main, dealerMicrodata = false }) {
    const head = [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${esc(title)}</title>`,
      `<meta property="og:site_name" content="${esc(DEALER.name)}">`,
      ogTitle ? `<meta property="og:title" content="${esc(ogTitle)}">` : '',
      canonical ? `<link rel="canonical" href="${esc(canonical)}">` : '',
      prev ? `<link rel="prev" href="${esc(prev)}">` : '',
      next ? `<link rel="next" href="${esc(next)}">` : '',
      ...blocks.map((b) => `<script type="application/ld+json">\n${ld(b)}\n</script>`),
      `<style>${STYLE}</style>`,
    ].filter(Boolean).join('\n');
    const address = `${esc(DEALER.street)}, ${esc(DEALER.city)}, ${esc(DEALER.state)} ${esc(DEALER.zip)} · ${esc(DEALER.phone)}`;
    const footer = dealerMicrodata
      ? `<footer itemscope itemtype="${SCHEMA}AutoDealer"><span itemprop="name">${esc(DEALER.name)}</span> · <span itemprop="address" itemscope itemtype="${SCHEMA}PostalAddress"><span itemprop="streetAddress">${esc(DEALER.street)}</span>, <span itemprop="addressLocality">${esc(DEALER.city)}</span>, <span itemprop="addressRegion">${esc(DEALER.state)}</span> <span itemprop="postalCode">${esc(DEALER.zip)}</span></span> · Sample data only.</footer>`
      : `<footer>${esc(DEALER.name)} · ${address} · Sample data only.</footer>`;
    const body = `<div class="sample">Sample website for Lot Sync's tests and sandbox. ${esc(DEALER.name)} is not a real dealership, and these are not real cars.</div>
<header class="site">
  <div class="logo">${esc(DEALER.name)} <small>${address}</small></div>
  <nav><a href="${esc(site.address('/'))}">Home</a><a href="${esc(site.address('/new-vehicles/'))}">New</a><a href="${esc(listAddress(site, 1))}">Used</a></nav>
</header>
<main>
${main}
</main>
${footer}`;
    return { head, body };
  }

  const html = (parts) => `<!doctype html>\n<html lang="en">\n<head>\n${parts.head}\n</head>\n<body>\n${parts.body}\n</body>\n</html>\n`;

  function photoStrip(site, c, microdata = false) {
    if (!c.photos) return '<div class="photos none">Photos coming soon</div>';
    return `<div class="photos">${photosOf(site, c).map((u, i) => `<img ${microdata ? 'itemprop="image" ' : ''}src="${esc(u)}" alt="${esc(plainName(c))}, photo ${i + 1}">`).join('')}</div>`;
  }

  function specs(c) {
    const items = [
      typeof c.mileage === 'number' ? miles(c.mileage) : 'No odometer (trailer)',
      `Stock ${c.stock}`,
      `VIN ${c.vin}`,
      c.exterior && `Exterior: ${c.exterior}`,
      c.interior && `Interior: ${c.interior}`,
      c.engine && `Engine: ${c.engine}`,
      c.transmission && `Transmission: ${c.transmission}`,
      c.drivetrain && `Drivetrain: ${c.drivetrain}`,
    ].filter(Boolean);
    return `<ul class="specs">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  }

  function card(site, c) {
    const url = site.address(vehicleRoute(c));
    const photo = c.photos ? `<img src="${esc(site.photo(c, 1))}" alt="" loading="lazy">` : 'Photos coming soon';
    const facts = [typeof c.mileage === 'number' ? miles(c.mileage) : '', c.transmission, c.drivetrain, `Stock ${c.stock}`].filter(Boolean).join(' · ');
    return `<article class="card" id="${esc(c.vin)}">
  <a class="photo" href="${esc(url)}">${photo}</a>
  <div class="body">
    <div class="type">${esc(condition(c))}</div>
    <a class="name" href="${esc(url)}">${esc(plainName(c))}</a>
    <div class="muted">${esc(facts)}</div>
    <div class="price">${money(c.shownPrice || c.price)}</div>
  </div>
</article>`;
  }

  function listPage(site, cars, n, pages) {
    const first = (n - 1) * PER_PAGE;
    const shown = cars.slice(first, first + PER_PAGE);
    const prev = n > 1 ? listAddress(site, n - 1) : '';
    const next = n < pages ? listAddress(site, n + 1) : '';
    const numbers = Array.from({ length: pages }, (_, i) => (i + 1 === n ? `<b>${n}</b>` : `<a href="${esc(listAddress(site, i + 1))}">${i + 1}</a>`)).join(' ');
    const main = `<h1>Used Vehicles for Sale</h1>
<p class="count">${cars.length} used vehicles · page ${n} of ${pages}</p>
<div class="grid">
${shown.map((c) => card(site, c)).join('\n')}
</div>
<nav class="pages" aria-label="Pages">${prev ? `<a rel="prev" href="${esc(prev)}">Previous</a> ` : ''}${numbers}${next ? ` <a rel="next" href="${esc(next)}">Next</a>` : ''}</nav>`;
    return layout(site, {
      title: `Used Cars for Sale in ${DEALER.city}, ${DEALER.state}${n > 1 ? ` (page ${n})` : ''} | ${DEALER.name}`,
      canonical: listAddress(site, n),
      prev,
      next,
      blocks: [dealerNode(site), listNode(site, shown, { name: 'Used vehicles', first: first + 1, total: cars.length })],
      main,
    });
  }

  function newListPage(site, cars) {
    const main = `<h1>New Vehicles for Sale</h1>
<p class="count">${cars.length} new vehicle${cars.length === 1 ? '' : 's'}</p>
<div class="grid">
${cars.map((c) => card(site, c)).join('\n')}
</div>`;
    return layout(site, { title: `New Cars for Sale | ${DEALER.name}`, canonical: site.address('/new-vehicles/'), blocks: [dealerNode(site), listNode(site, cars, { name: 'New vehicles', first: 1, total: cars.length })], main });
  }

  function homePage(site) {
    const main = `<h1>Welcome to ${esc(DEALER.name)}</h1>
<p>Quality used cars in ${esc(DEALER.city)}, ${esc(DEALER.state)}.</p>
<p><a href="${esc(listAddress(site, 1))}">Shop used vehicles</a> · <a href="${esc(site.address('/new-vehicles/'))}">Shop new vehicles</a></p>`;
    return layout(site, { title: `${DEALER.name} | Used Cars in ${DEALER.city}, ${DEALER.state}`, canonical: site.address('/'), blocks: [dealerNode(site)], main });
  }

  function vehiclePage(site, c, cars) {
    const url = site.address(vehicleRoute(c));
    const carfax = typeof site.carfax === 'function' && c.carfax ? site.carfax(c) : '';
    const similar = (c.similar || []).map((k) => cars.find((x) => x.key === k)).filter(Boolean);
    const blocks = c.markup === 'microdata' ? [] : c.markup === 'graph' ? [graphNode(site, c)] : [dealerNode(site), carNode(site, c), ...(similar.length ? [carouselNode(site, similar)] : [])];
    const main = c.markup === 'microdata'
      ? microdataCar(site, c)
      : `<article class="car">
  <h1>${esc(nameOf(c))}</h1>
  ${photoStrip(site, c)}
  <p class="price">Our price <b>${money(c.shownPrice || c.price)}</b></p>
  ${specs(c)}
  <p class="desc">${esc(descriptionOf(c))}</p>
  <ul class="features">${c.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
</article>`;
    const extras = [
      carfax ? `<p><a href="${esc(carfax)}">Free Carfax report</a></p>` : '',
      `<p><a href="${esc(listAddress(site, 1))}">Back to used vehicles</a></p>`,
      similar.length
        ? `<aside class="carousel"><h2>Similar vehicles</h2><ul>${similar.map((s) => `<li><a href="${esc(site.address(vehicleRoute(s)))}">${esc(nameOf(s))}</a> ${money(s.shownPrice || s.price)}</li>`).join('')}</ul></aside>`
        : '',
    ].join('\n');
    return layout(site, {
      title: `${nameOf(c)} for Sale in ${DEALER.city}, ${DEALER.state} | ${DEALER.name}`,
      ogTitle: nameOf(c),
      canonical: url,
      blocks,
      main: main + '\n' + extras,
      dealerMicrodata: c.markup === 'microdata',
    });
  }

  function gonePage(site, c) {
    const main = `<h1>This vehicle is no longer available</h1>
<p>The ${esc(plainName(c))} you are looking for has been sold or removed.</p>
<p><a href="${esc(listAddress(site, 1))}">See our used vehicles</a></p>`;
    return layout(site, { title: `Vehicle no longer available | ${DEALER.name}`, blocks: [dealerNode(site)], main });
  }

  function notFoundPage(site) {
    return layout(site, { title: `Page not found | ${DEALER.name}`, blocks: [dealerNode(site)], main: `<h1>Page not found</h1>\n<p><a href="${esc(listAddress(site, 1))}">See our used vehicles</a></p>` });
  }

  function sitemap(site, cars) {
    const urls = [site.address('/'), listAddress(site, 1), ...cars.map((c) => site.address(vehicleRoute(c)))];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
  }

  const robots = (site) => `# ${DEALER.name} (sample website)\nUser-agent: *\nDisallow: /admin/\nSitemap: ${site.address('/sitemap.xml')}\n`;

  // ---------- answering an address ----------

  const HTML = 'text/html; charset=utf-8';
  const pageAnswer = (status, parts) => ({ status, type: HTML, body: html(parts), parts });

  /**
   * What the website answers for one address, or null for an address that
   * is not one of its pages (another website, or a photo file).
   * { status, type, body, parts?: { head, body }, location? }: a 301 carries
   * location; with follow it is followed, as fetch follows it, and the answer
   * says redirected and its final url.
   * @param {string} url
   * @param {'day1'|'day2'|object} scenario
   * @param {ReturnType<typeof pathSite>} site
   */
  function respond(url, scenario, site, { follow = false } = {}) {
    const route = site.route(url);
    if (route === null) return null;
    const cars = lot(scenario);
    const all = onWebsite(scenario);
    const pages = Math.max(1, Math.ceil(cars.length / PER_PAGE));
    if (route === '/robots.txt') return { status: 200, type: 'text/plain; charset=utf-8', body: robots(site) };
    if (route === '/sitemap.xml') return { status: 200, type: 'application/xml; charset=utf-8', body: sitemap(site, cars) };
    if (route === '/') return pageAnswer(200, homePage(site));
    const list = /^\/used-vehicles\/?(?:\?page=(\d+))?$/.exec(route);
    if (list) {
      const n = Number(list[1] || 1);
      return n >= 1 && n <= pages ? pageAnswer(200, listPage(site, cars, n, pages)) : pageAnswer(404, notFoundPage(site));
    }
    if (/^\/new-vehicles\/?$/.test(route)) return pageAnswer(200, newListPage(site, all.filter((c) => c.type === 'New')));
    const bare = route.replace(/\/?$/, '/');
    const car = CARS.find((c) => vehicleRoute(c) === bare);
    const now = car && all.find((c) => c.vin === car.vin);
    if (now) return pageAnswer(200, vehiclePage(site, now, all));
    const s = readScenario(scenario);
    if (car && s.name === 'day2' && car.vin === day2Plan(s).sold) {
      const how = day2Plan(s).soldPage;
      if (how === '301') {
        const to = listAddress(site, 1);
        return follow ? { ...respond(to, scenario, site), redirected: true, url: to } : { status: 301, type: HTML, body: '', location: to };
      }
      if (how === '200') return pageAnswer(200, gonePage(site, car));
    }
    return pageAnswer(404, notFoundPage(site));
  }

  const api = {
    DEALER, CARS, VINS, PER_PAGE, DAY2_DEFAULTS, DAY2_ORDER, SOLD_PAGES, SCENARIOS: ['day1', 'day2'],
    lot, onWebsite, describeDay2, day2Plan, readScenario, respond, pathSite, hashSite,
    nameOf, plainName, vehicleRoute, listAddress,
  };
  root.LOT_SYNC_STANDARD = api;
})(typeof window !== 'undefined' ? window : globalThis);
