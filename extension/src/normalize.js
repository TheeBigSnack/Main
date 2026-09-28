// Helpers shared by every adapter's normaliser and by the modules that read
// the flat vehicle. The flat shape itself is src/vehicle.js (VEHICLE_FIELDS,
// re-exported here); each platform's record-to-vehicle code lives next to
// its adapter under extension/adapters/ (Dealer Inspire:
// adapters/dealerInspireNormalize.js). Nothing platform-specific lives here.

export { VEHICLE_FIELDS } from './vehicle.js';

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

const BRANDS =
  'Chrysler|Dodge|Jeep|Ram|Fiat|Alfa Romeo|Ford|Lincoln|Chevrolet|Buick|GMC|Cadillac|Toyota|Lexus|Honda|Acura|Nissan|Infiniti|Hyundai|Genesis|Kia|Subaru|Mazda|Volkswagen|Audi|BMW|Mercedes-Benz|Volvo';

export function shortLocation(location) {
  if (!location) return '';
  // "Ron Lewis Chrysler Dodge Jeep Ram Cranberry" -> "Cranberry" (text after the last brand name)
  const m = location.match(new RegExp(`^.*\\b(?:${BRANDS})\\s+(.+)$`));
  return m ? m[1].trim() : location;
}
