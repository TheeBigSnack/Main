// Why a queued car waits at review instead of opening its form by itself.
// The side panel reads the car's state and passes it in as facts; this lists
// each reason that holds the car, in the order the checks run, so the first
// one is the one the status line names. An empty list means nothing holds it.
//
// facts: {
//   guardrails: { ok, problems: [{ text }] } | null,
//   relist: object | null            (this car's take-down while the website still listed it)
//   vinProblems: [{ label, detail }] (the local VIN check's failed checks)
//   brandingRunning: boolean         (the photo check is still running)
//   croppedPhotos: number            (photos the check cropped that the person has not seen)
//   missing: [{ key, label }]        (form fields the website gives no value for)
//   assumed: [{ key, label, value, why }]
//   branded: string                  (the website's text that mentions a branded title)
//   unknownPhotoServers: boolean     (a photo server Chrome has not been allowed to read)
//   cap: { reached, count }          (the day's post cap)
// }

// the title fields the person picks on the form, so a blank one never holds a car
const TITLE_FIELDS = ['titleStatus', 'cleanTitle'];
// the dealership's own defaults, shown on the form but never a reason to hold
const DEFAULT_FIELDS = ['condition', 'titleStatus'];

export function queueHoldReasons(facts = {}) {
  const out = [];
  const g = facts.guardrails;
  if (!g) out.push({ key: 'guardrails', text: 'The description has not been checked yet.', kind: '' });
  else if (!g.ok) {
    const first = (g.problems || [])[0];
    out.push({ key: 'guardrails', text: first ? `The description needs a fix first: ${first.text}.` : 'The description needs a fix first.', kind: '' });
  }
  if (facts.relist) out.push({ key: 'relist', text: 'This car was taken down on Facebook while the website still lists it. Read the notice before posting.', kind: '' });
  const vin = facts.vinProblems || [];
  if (vin.length) out.push({ key: 'vin', text: `The VIN check failed: ${vin[0].label}: ${vin[0].detail}.`, kind: '' });
  if (facts.brandingRunning) out.push({ key: 'branding', text: 'The photo check is still running.', kind: '' });
  const cropped = Number(facts.croppedPhotos) || 0;
  if (cropped > 0) out.push({ key: 'cropped', text: `The photo check cropped ${cropped} photo${cropped === 1 ? '' : 's'} on this listing; look at ${cropped === 1 ? 'it' : 'them'} before posting.`, kind: '' });
  const blanks = (facts.missing || []).filter((f) => !TITLE_FIELDS.includes(f.key));
  if (blanks.length) {
    const more = blanks.length > 1 ? ` (and ${blanks.length - 1} more blank)` : '';
    out.push({ key: 'missing', text: `${blanks[0].label} is missing: the website gives no value for it${more}.`, kind: '' });
  }
  const assumed = (facts.assumed || []).filter((a) => !DEFAULT_FIELDS.includes(a.key));
  if (assumed.length) out.push({ key: 'assumed', text: `Assumed: ${assumed[0].label} is ${assumed[0].value} (${assumed[0].why}). Check it on the form.`, kind: '' });
  if (facts.branded) out.push({ key: 'branded', text: `The website's text mentions a branded title ("${facts.branded}"). Pick the title on the form.`, kind: '' });
  if (facts.unknownPhotoServers) out.push({ key: 'photoServer', text: 'The photos come from a server Chrome has not been allowed to read yet; Chrome asks when the form opens.', kind: '' });
  const cap = facts.cap || {};
  if (cap.reached) out.push({ key: 'cap', text: `Daily post cap reached (${cap.count}). It resets tomorrow; the dealer can change it in Settings.`, kind: 'error' });
  return out;
}

// The status line for the first reason a queued car is held at review. A held
// car is not an error, except at the day's cap, where the form cannot open.
export function holdStatus(reason) {
  if (reason.key === 'cap') return { text: reason.text, kind: 'error' };
  return { text: `${reason.text} Click Open the Marketplace form when it is right; the queue carries on after this car.`, kind: '' };
}
