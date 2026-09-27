// The dealer-website platforms Lot Sync can read. Each adapter implements
// detect / scan / normalize / getDetails / makeDirectSearch (see
// dealerInspire.js). Only Dealer Inspire is built; the others are listed in
// README.md as TODOs so the next one is chosen from demand, not guesswork.

import dealerInspire from './dealerInspire.js';

export const ADAPTERS = Object.freeze([dealerInspire]);

export function detectAdapter(probe) {
  return ADAPTERS.find((a) => a.detect(probe)) || null;
}

export function adapterById(id) {
  return ADAPTERS.find((a) => a.PLATFORM.id === id) || null;
}
