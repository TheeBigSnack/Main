// The dealership name the site probe reads when a website gives no og:site_name: the page title's
// part that names the dealer, not the page words (Used, Vehicles for Sale, Home) around it.
// The probe runs as written here, with a stubbed page: no og:site_name, the title given, no
// structured data and no address in the page text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSiteInPage } from '../extension/src/scan.js';

function nameFor(title, { ogName = null } = {}) {
  globalThis.document = {
    title,
    body: { innerText: '' },
    querySelector: (sel) => (sel === 'meta[property="og:site_name"]' && ogName ? { content: ogName } : null),
    querySelectorAll: () => [],
  };
  globalThis.location = { hostname: 'www.example-dealer.test', origin: 'https://www.example-dealer.test', href: 'https://www.example-dealer.test/used-vehicles/' };
  try {
    return probeSiteInPage().name;
  } finally {
    delete globalThis.document;
    delete globalThis.location;
  }
}

test('a dash title gives the dealer part, not the whole title', () => {
  assert.equal(nameFor('Used Vehicles for Sale - Example Motors Waynesburg'), 'Example Motors Waynesburg');
  assert.equal(nameFor('Used Vehicles for Sale – Example Motors Waynesburg'), 'Example Motors Waynesburg', 'an en dash too');
});

test('a pipe title gives the dealer part, whichever end it is at', () => {
  assert.equal(nameFor('Example Motors Waynesburg | Used Vehicles'), 'Example Motors Waynesburg', 'not "Used Vehicles"');
  assert.equal(nameFor('Used Vehicles | Example Motors'), 'Example Motors');
  assert.equal(nameFor('Used Car King | Used Vehicles'), 'Used Car King', 'a name with page words in it keeps them when they are not all of it');
});

test('a single part is the name unless it is only page words', () => {
  assert.equal(nameFor('Example Motors'), 'Example Motors');
  assert.equal(nameFor('Used Vehicles for Sale'), '', 'no name: the wizard asks for one');
  assert.equal(nameFor('Home | Used Cars'), '', 'two page words name nothing');
});

test('when no part is clearly the name, the name stays blank', () => {
  assert.equal(nameFor('Example Motors | Waynesburg, PA'), '', 'two parts could be the name: say nothing');
  assert.equal(nameFor(''), '');
});

test('og:site_name still wins over the title', () => {
  assert.equal(nameFor('Used Vehicles | Something Else', { ogName: 'Example Motors' }), 'Example Motors');
});
