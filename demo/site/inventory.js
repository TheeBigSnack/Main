// The sample lot behind the sandbox's fake dealership website ("Example
// Motors", Springfield, OH). Every value here is made up: the dealership, the
// stock numbers, the mileages, the prices, the descriptions and the VINs
// (which spell SAMPLE and still pass extension/src/vin.js's check digit,
// model year and manufacturer checks, so the side panel's VIN check reads
// "agrees"). The record shape is the one a Dealer Inspire site's search
// service returns (the fields extension/adapters/dealerInspire.js asks for),
// so the real extension code reads this lot exactly as it reads a live site.
//
// Plain script, no imports: the fake site page, the sandbox page and
// test/demo.test.js (through node:vm) all load it. It defines
// window.LOT_SYNC_INVENTORY = { records(scenario, base), SCENARIOS, VINS }.
//
// Scenarios: 'day1' is the lot as scanned first. 'day2' is the next day: one
// car sold (gone from the website), one price dropped, the car without photos
// got them, and a new arrival. The sandbox page passes { name: 'day2', sold,
// dropped } to make the sold car and the price drop hit the cars the person
// has posted; without that, the defaults below apply.

(function (root) {
  'use strict';

  const DOC_FEE = 250;
  const DISCLAIMER = `Example Motors Price includes the $${DOC_FEE} documentation fee. Tax, title and registration are extra. Sample listing for the Lot Sync sandbox; not a real vehicle.`;

  // Each car in a short form; build() turns it into the service's record.
  const CARS = [
    {
      key: 'f150', vin: '1FTSAMPL9LE000001', stock: 'EM1001', type: 'Used', year: 2020, make: 'Ford', model: 'F-150', trim: 'XLT', mileage: 34512, price: 32995,
      slug: 'used-2020-ford-f-150-xlt-4wd-supercrew', location: 'Example Motors Springfield', carfax: true, oneOwner: true, photos: 3,
      exterior: 'Velocity Blue', interior: 'Medium Earth Gray', body: 'Trucks', drivetrain: '4WD', engine: '2.7L EcoBoost V6', transmission: '10-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['4WD', 'Backup Camera', 'Apple CarPlay', 'Tow Package', 'Bluetooth', 'Keyless Entry', 'Cruise Control', 'Power Windows'],
      narrative: 'This 2020 F-150 XLT SuperCrew pairs the 2.7L EcoBoost V6 with 4WD and the 10-Speed Automatic. It came to us on trade and has been through our shop.',
    },
    {
      key: 'rav4', vin: '4T3SAMPL1ME000002', stock: 'EM1002', type: 'Used', year: 2021, make: 'Toyota', model: 'RAV4', trim: 'XLE', mileage: 28904, price: 27495,
      slug: 'used-2021-toyota-rav4-xle-awd', location: 'Example Motors Springfield', carfax: true, oneOwner: false, photos: 3,
      exterior: 'Magnetic Gray Metallic', interior: 'Black', body: 'SUVs', drivetrain: 'AWD', engine: '2.5L 4-Cylinder', transmission: '8-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['AWD', 'Backup Camera', 'Apple CarPlay', 'Android Auto', 'Blind Spot Monitor', 'Adaptive Cruise Control', 'Heated Front Seats'],
      narrative: '',
    },
    {
      key: 'civic', vin: '2HGSAMPL6KE000003', stock: 'EM1003', type: 'Used', year: 2019, make: 'Honda', model: 'Civic', trim: 'EX', mileage: 41230, price: 19995,
      slug: 'used-2019-honda-civic-ex-sedan', location: 'Example Motors Springfield', carfax: true, oneOwner: true, photos: 3,
      exterior: 'Lunar Silver Metallic', interior: 'Gray', body: 'Sedan', drivetrain: 'FWD', engine: '1.5L Turbo 4-Cylinder', transmission: 'CVT', fuel: 'Gasoline Fuel',
      features: ['Sunroof', 'Backup Camera', 'Apple CarPlay', 'Heated Front Seats', 'Bluetooth', 'Lane Keeping Assist', 'Remote Start'],
      narrative: 'A one-owner Civic EX with the 1.5L turbo and a sunroof, serviced here since new.',
    },
    {
      key: 'grandCherokee', vin: '1C4SAMPL7NE000004', stock: 'EM1004', type: 'Certified Used', year: 2022, make: 'Jeep', model: 'Grand Cherokee', trim: 'Laredo', mileage: 22118, price: 33995,
      slug: 'certified-used-2022-jeep-grand-cherokee-laredo-4wd', location: 'Example Motors Springfield', carfax: true, oneOwner: true, photos: 3,
      exterior: 'Bright White Clearcoat', interior: 'Global Black', body: 'SUVs', drivetrain: '4WD', engine: '3.6L V6', transmission: '8-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['4WD', 'Backup Camera', 'Apple CarPlay', 'Heated Front Seats', 'Remote Start', 'Blind Spot Monitor', 'Keyless Entry'],
      narrative: '',
    },
    {
      // no photos on day 1 (Not ready); they arrive on day 2 (Just became ready)
      key: 'equinox', vin: '3GNSAMPL1JE000005', stock: 'EM1005', type: 'Used', year: 2018, make: 'Chevrolet', model: 'Equinox', trim: 'LT', mileage: 61377, price: 15995,
      slug: 'used-2018-chevrolet-equinox-lt-fwd', location: 'Example Motors Springfield', carfax: true, oneOwner: false, photos: 0,
      exterior: 'Summit White', interior: 'Jet Black', body: 'SUVs', drivetrain: 'FWD', engine: '1.5L Turbo 4-Cylinder', transmission: '6-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['Backup Camera', 'Apple CarPlay', 'Bluetooth', 'Keyless Entry', 'Power Windows', 'Cruise Control'],
      narrative: '',
    },
    {
      // "Please call for price": pre-owned, but not ready
      key: 'ram', vin: '1C6SAMPL6HE000006', stock: 'EM1006', type: 'Used', year: 2017, make: 'Ram', model: '1500', trim: 'Big Horn', mileage: 88402, price: null,
      slug: 'used-2017-ram-1500-big-horn-4wd-crew-cab', location: 'Example Motors Springfield', carfax: true, oneOwner: false, photos: 3,
      exterior: 'Bright Silver Metallic', interior: 'Black/Diesel Gray', body: 'Trucks', drivetrain: '4WD', engine: '5.7L V8 HEMI', transmission: '8-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['4WD', 'Tow Package', 'Backup Camera', 'Bluetooth', 'Power Windows', 'Cruise Control'],
      narrative: '',
    },
    {
      // at the group's other store: kept off the Springfield salesperson's list
      key: 'tucson', vin: '5NMSAMPL6ME000007', stock: 'EM1007', type: 'Used', year: 2021, make: 'Hyundai', model: 'Tucson', trim: 'SEL', mileage: 30655, price: 21495,
      slug: 'used-2021-hyundai-tucson-sel-awd', location: 'Example Motors Shelbyville', carfax: true, oneOwner: true, photos: 3,
      exterior: 'Stellar Silver', interior: 'Gray', body: 'SUVs', drivetrain: 'AWD', engine: '2.5L 4-Cylinder', transmission: '8-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['AWD', 'Backup Camera', 'Apple CarPlay', 'Blind Spot Monitor', 'Heated Front Seats', 'Keyless Entry'],
      narrative: '',
    },
    {
      // 0 miles on a used car: the website's details don't add up (Needs a look)
      key: 'cx5', vin: 'JM3SAMPL8RE000008', stock: 'EM1008', type: 'Used', year: 2024, make: 'Mazda', model: 'CX-5', trim: '2.5 S Preferred', mileage: 0, price: 27995,
      slug: 'used-2024-mazda-cx-5-2-5-s-preferred-awd', location: 'Example Motors Springfield', carfax: true, oneOwner: true, photos: 3,
      exterior: 'Soul Red Crystal Metallic', interior: 'Black', body: 'SUVs', drivetrain: 'AWD', engine: '2.5L 4-Cylinder', transmission: '6-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['AWD', 'Backup Camera', 'Apple CarPlay', 'Heated Front Seats', 'Blind Spot Monitor', 'Keyless Entry'],
      narrative: '',
    },
    {
      // new: never posted
      key: 'explorer', vin: '1FMSAMPL5VE000009', stock: 'EM2001', type: 'New', year: 2027, make: 'Ford', model: 'Explorer', trim: 'XLT', mileage: 0, price: 44995, msrp: true,
      slug: 'new-2027-ford-explorer-xlt-4wd', location: 'Example Motors Springfield', carfax: false, oneOwner: false, photos: 3,
      exterior: 'Star White Metallic', interior: 'Ebony', body: 'SUVs', drivetrain: '4WD', engine: '2.3L EcoBoost 4-Cylinder', transmission: '10-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['4WD', 'Backup Camera', 'Apple CarPlay', 'Heated Front Seats', 'Third Row Seating'],
      narrative: '',
    },
    {
      // new and still in transit: never posted
      key: 'camry', vin: '4T1SAMPL8VE000010', stock: '', type: 'New', year: 2027, make: 'Toyota', model: 'Camry', trim: 'LE', mileage: 0, price: 29495, msrp: true, inTransit: true,
      slug: 'new-2027-toyota-camry-le-fwd', location: 'Example Motors Springfield', carfax: false, oneOwner: false, photos: 3,
      exterior: 'Celestial Silver Metallic', interior: 'Black', body: 'Sedan', drivetrain: 'FWD', engine: '2.5L 4-Cylinder Hybrid', transmission: 'CVT', fuel: 'Gasoline/Electric Hybrid',
      features: ['Backup Camera', 'Apple CarPlay', 'Adaptive Cruise Control', 'Lane Keeping Assist'],
      narrative: '',
    },
    {
      // the day-2 arrival
      key: 'sorento', vin: '5XYSAMPL2ME000011', stock: 'EM1011', type: 'Used', year: 2021, make: 'Kia', model: 'Sorento', trim: 'LX', mileage: 35780, price: 24995, day2Only: true,
      slug: 'used-2021-kia-sorento-lx-awd', location: 'Example Motors Springfield', carfax: true, oneOwner: true, photos: 3,
      exterior: 'Everlasting Silver', interior: 'Black', body: 'SUVs', drivetrain: 'AWD', engine: '2.5L 4-Cylinder', transmission: '8-Speed Automatic', fuel: 'Gasoline Fuel',
      features: ['AWD', 'Backup Camera', 'Apple CarPlay', 'Third Row Seating', 'Blind Spot Monitor', 'Keyless Entry'],
      narrative: '',
    },
  ];

  const byKey = Object.fromEntries(CARS.map((c) => [c.key, c]));
  const VINS = Object.fromEntries(CARS.map((c) => [c.key, c.vin]));

  // What day 2 changes when the sandbox page gives no posted cars to aim at.
  const DAY2_DEFAULTS = { sold: VINS.civic, dropped: VINS.f150, drop: 1000, gotPhotos: VINS.equinox, arrival: VINS.sorento };

  const condition = (type) => (type === 'New' ? 'New' : type === 'Certified Used' ? 'Certified Pre-Owned' : 'Pre-Owned');
  const titleOf = (c) => `${condition(c.type)} ${c.year} ${c.make} ${c.model} ${c.trim}`.trim();

  // The website shows two prices per car, the way Dealer Inspire sites do: the
  // main "Example Motors Price" (with the doc fee) and a lower "Was" price.
  function pricing(c, price) {
    const label = 'Example Motors Price';
    if (!price) {
      return {
        pricing: { price: 0, our_price: 0, internet_price: 0, original_price: 0, msrp: 0, original_price_label: label },
        display: { low: false, high: { label, value: 'Please call for price' }, savings: { value: 0 } },
      };
    }
    const lower = price - DOC_FEE;
    return {
      pricing: { price: lower, our_price: price, internet_price: lower, original_price: lower, msrp: c.msrp ? lower : 0, original_price_label: c.msrp ? 'MSRP' : 'Was' },
      display: { low: { label, value: String(price) }, high: { label: c.msrp ? 'MSRP' : 'Was', value: String(lower) }, savings: { value: 0 } },
    };
  }

  function build(c, base, { price = c.price, photos = c.photos } = {}) {
    const p = pricing(c, price);
    const bullets = c.features.slice(0, 3).map((f) => `- ${f}`).join('<br>');
    const description = (c.narrative ? `${c.narrative}<br>${bullets}<br>` : `Recent Arrival! ${c.features.join(', ')}, Air Conditioning, Power Steering, Tilt Wheel, AM/FM Stereo.<br>`) + DISCLAIMER;
    const images = Array.from({ length: photos }, (_, i) => `${base}photos/${c.key}-${i + 1}.svg`);
    const title = titleOf(c);
    return {
      vin: c.vin, stock: c.stock, type: c.type, year: c.year, make: c.make, model: c.model, trim: c.trim, mileage: c.mileage,
      vdp_url: `${base}index.html#/inventory/${c.slug}-${c.vin.toLowerCase()}/`,
      status: 'publish', in_transit: c.inTransit ? 'yes' : c.type === 'New' ? 'no' : 'unknown', is_demo: false, is_loaner: false,
      date_in_stock: '2026-09-20T00:00:00.000Z',
      history_report: { carfax_url: c.carfax ? `${base}index.html#/history/${c.vin}` : null, carfax_icon_url: null, carfax_oneowner: c.carfax ? c.oneOwner : null },
      pricing: p.pricing,
      media: { image_count: images.length, images },
      description,
      features: c.features.slice(),
      styles: { exterior_color: c.exterior, interior_color: c.interior },
      body_details: { type: c.body },
      mechanical: { drivetrain: c.drivetrain, engine: c.engine, transmission: c.transmission, fuel_type: c.fuel },
      extra_fields: {
        readable_type: condition(c.type), title, meta_location: c.location, location_rt: c.location,
        availability_rt: c.inTransit ? 'In-Transit' : 'In-Stock', our_price_label: 'Example Motors Price',
        lightning: { inventoryType: c.type, vdp_title: title, status: '', statusLabel: '', pricing: p.display },
      },
    };
  }

  const readScenario = (scenario) => (typeof scenario === 'string' ? { name: scenario } : scenario && typeof scenario === 'object' ? scenario : { name: 'day1' });

  /**
   * The lot for a scenario, with every URL under `base` (the fake site's
   * folder, e.g. http://127.0.0.1:8765/demo/site/).
   * @param {'day1'|'day2'|{name, sold?, dropped?}} scenario
   */
  function records(scenario, base) {
    const s = readScenario(scenario);
    const b = String(base || './').replace(/\/?$/, '/');
    if (s.name !== 'day2') return CARS.filter((c) => !c.day2Only).map((c) => build(c, b));
    const known = (vin) => CARS.find((c) => c.vin === String(vin || '').toUpperCase() && !c.day2Only && c.type !== 'New');
    const sold = (known(s.sold) || byKey.civic).vin;
    let dropped = known(s.dropped) && known(s.dropped).price ? known(s.dropped) : byKey.f150;
    if (dropped.vin === sold) dropped = CARS.find((c) => c.vin !== sold && c.price && c.type !== 'New' && !c.day2Only);
    return CARS.filter((c) => c.vin !== sold && (!c.day2Only || c.vin === DAY2_DEFAULTS.arrival)).map((c) => {
      if (c.vin === dropped.vin) return build(c, b, { price: c.price - DAY2_DEFAULTS.drop });
      if (c.vin === DAY2_DEFAULTS.gotPhotos) return build(c, b, { photos: 3 });
      return build(c, b);
    });
  }

  // What day 2 will do for a given scenario object: the sandbox page uses it for its status line.
  function describeDay2(scenario) {
    const s = readScenario(scenario);
    const day1 = records('day1', './');
    const day2 = records(s, './');
    const name = (r) => `${r.year} ${r.make} ${r.model} ${r.trim}`.trim();
    const soldRec = day1.find((r) => !day2.some((d) => d.vin === r.vin));
    const droppedRec = day2.find((r) => { const before = day1.find((d) => d.vin === r.vin); return before && before.pricing.our_price && r.pricing.our_price < before.pricing.our_price; });
    const arrived = day2.find((r) => !day1.some((d) => d.vin === r.vin));
    return { sold: soldRec ? name(soldRec) : '', dropped: droppedRec ? name(droppedRec) : '', drop: DAY2_DEFAULTS.drop, arrived: arrived ? name(arrived) : '' };
  }

  // One search request answered the way the inventory service answers it:
  // filters on type, vin and status, paging, and the total. The fake site's
  // in-page helper and the sandbox's stand-in for the service's POST endpoint
  // (the background rescan) both use this.
  function search(list, body) {
    const b = body && typeof body === 'object' ? body : {};
    const f = b.filters || {};
    const has = (arr, v) => !Array.isArray(arr) || !arr.length || arr.includes(v);
    const hits = list.filter((r) => has(f.type, r.type) && has(f.vin, r.vin) && has(f.status, r.status));
    const perPage = Number(b.perPage) > 0 ? Number(b.perPage) : 50;
    const page = Number(b.page) > 0 ? Number(b.page) : 1;
    const start = (page - 1) * perPage;
    return { ccid: 1, total_vehicle_count: hits.length, listings: hits.slice(start, start + perPage) };
  }

  const api = { CARS, VINS, DOC_FEE, DAY2_DEFAULTS, SCENARIOS: ['day1', 'day2'], records, search, describeDay2, titleOf };
  root.LOT_SYNC_INVENTORY = api;
})(typeof window !== 'undefined' ? window : globalThis);
