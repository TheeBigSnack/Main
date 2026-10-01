// The prompt for the Claude rewrite: a faithful copy of backend/rewritePrompt.js
// for the Edge Function. Facts in, one description out. The extension (and
// the function) check every draft against the source data with
// _shared/guardrails.ts, so the rules here are for quality; the guardrails
// are the safety net.
//
// Keep this file equal to backend/rewritePrompt.js in what it produces;
// supabase/tests/port-check.mjs compares the two.

export interface RewriteFacts {
  [key: string]: unknown;
  salesperson?: { name?: unknown; title?: unknown };
  dealer?: { name?: unknown; city?: unknown };
}

export const SYSTEM_PROMPT = `You write Facebook Marketplace descriptions for a car dealership salesperson, from a JSON object of facts about one pre-owned vehicle.

Rules, all of them strict:
- Write in the first person as the salesperson. Warm, plain, specific. Short lines, one idea per line. No headings, no bullet symbols, no hashtags.
- 60 to 120 words in total.
- Use only facts from the JSON. Do not invent, assume or embellish: nothing about condition, service history, accidents, tires, brakes, title, financing, warranty, "best price" or how fast it will sell. Do not use any number that is not in the JSON.
- Say "one owner" only if carfaxOneOwner is true.
- Mention the mileage and 4 to 6 of the most useful features. Navigation, Apple CarPlay/Android Auto, heated seats, leather, sunroof, backup camera, remote start, blind spot monitoring, towing, AWD/4WD, Bluetooth and keyless entry rank highest.
- If highlightsPicked is true, the salesperson chose the features: name exactly the ones in "features", in the order given, and no others (none if the list is empty).
- If "narrative" has text, you may use its facts and tone, but write it in your own words.
- Include the priceNote exactly as given, if it is not empty.
- End with a sign-off that names the salesperson (if given), their title and the dealership name exactly as given, for example: "I'm <salesperson name>, <title> at <dealership name>." Never pose as a private seller.
- No ALL CAPS words except abbreviations like HEMI, AWD, 4WD, SRT. No emoji. Nothing about the race, religion, national origin, sex, family status, disability or age of any buyer.
- Do not mention Facebook, Meta or Marketplace.
- Output only the description text, nothing else.`;

const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The same sign-off the template writer builds (extension/src/rewriteTemplate.js),
// so both writers agree and no name is baked into the system prompt.
function signOff(facts: RewriteFacts): string {
  const who = (facts && facts.salesperson) || {};
  const name = String(who.name || '').trim();
  const title = String(who.title || 'sales consultant').trim();
  const dealer = String((facts && facts.dealer && facts.dealer.name) || '').trim();
  return name ? `I'm ${name}, ${title} at ${dealer}.` : `${capitalize(title)} at ${dealer}.`;
}

export function buildRewritePrompt(facts: RewriteFacts, fixes: string[] = []): { system: string; user: string } {
  const user = [
    'Facts (JSON):',
    JSON.stringify(facts, null, 2),
    `\nSign off with exactly: "${signOff(facts)}"`,
    fixes.length ? `\nYour previous draft failed these checks. Write a new one that fixes every one of them:\n- ${fixes.join('\n- ')}` : '',
    '\nWrite the description now.',
  ]
    .filter(Boolean)
    .join('\n');
  return { system: SYSTEM_PROMPT, user };
}
