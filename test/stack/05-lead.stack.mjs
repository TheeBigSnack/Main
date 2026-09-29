// The lead function with LEAD_ORIGINS set, behind the local gateway
// (supabase/README.md, "Demo requests"): another page's Origin gets 403, the
// honeypot is answered 200 and stores nothing, a real request is stored with
// the page's origin. Then, for information only, which address headers reach
// the function's per-sender brake through this gateway: the hosted gateway
// may differ, and the README's check on the first deploy stays the one that
// counts.

export const title = 'The lead function: origin, honeypot, a stored request, and the address headers';

const STRANGER = 'https://not-the-landing-page.test';

export async function run(s) {
  const post = (body, { origin = s.siteOrigin, headers = {}, quiet = false } = {}) =>
    s.http('POST', '/functions/v1/lead', { headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body, quiet });
  const form = (email) => ({ name: 'Stack Visitor', dealership: 'Stack Test Motors', website: 'www.stack-lead.example', email, phone: '', message: 'A demo request from the stack test.' });
  const stored = (email) => Number(s.sql(`select count(*) from public.demo_requests where email = ${s.lit(email)}`));
  const braked = (r) => (r.status === 429 ? ': the per-sender brake still holds this machine from an earlier run; restart `supabase functions serve` and run again' : '');

  const other = await post(form(`other-${s.run}@lotsync-stack.test`), { origin: STRANGER });
  const allow = other.headers.get('access-control-allow-origin');
  s.check('a page that is not the landing page gets 403', other.status === 403, `HTTP ${other.status} ${s.brief(other.body)}`);
  if (allow === '*' && s.gatewayCors) s.note('its answer carries allow-origin *, which the local gateway adds to every answer', 'the function sends none for another page (test/fn-lead.test.js); npm run check-deploy checks the hosted project');
  else s.check('and no CORS header, so that page cannot read the answer', !allow, `allow-origin ${allow || 'none'}`);

  const botEmail = `bot-${s.run}@lotsync-stack.test`;
  const bot = await post({ ...form(botEmail), company_url: 'https://spam.example' });
  s.check('the honeypot is answered 200 { ok: true }', bot.status === 200 && bot.body && bot.body.ok === true, `HTTP ${bot.status} ${s.brief(bot.body)}${braked(bot)}`);
  const botRows = stored(botEmail);
  s.check('and nothing of it is stored', botRows === 0, `${botRows} row(s)`);

  const leadEmail = `lead-${s.run}@lotsync-stack.test`;
  const lead = await post(form(leadEmail));
  s.check('a real request is answered 200 { ok: true }', lead.status === 200 && lead.body && lead.body.ok === true, `HTTP ${lead.status} ${s.brief(lead.body)}${braked(lead)}`);
  const row = s.sql(`select concat_ws('|', name, dealership, website, page_origin) from public.demo_requests where email = ${s.lit(leadEmail)}`);
  s.check('and stored once, with what the visitor typed and the page\'s origin', row === `Stack Visitor|Stack Test Motors|www.stack-lead.example|${s.siteOrigin}`, row || 'no row');

  // Which address headers reach the brake (5 an hour per key, per instance).
  // An empty form is answered 400 and stores nothing, but the brake counts it
  // first, so a key that is used up answers 429. Each round sends up to 7
  // requests and stops at the first 429.
  const tag = s.run.slice(-4).padStart(4, '0');
  const round = async (headersFor) => {
    const seen = [];
    for (let i = 1; i <= 7; i += 1) {
      const r = await post('{}', { headers: headersFor(i), quiet: true });
      seen.push(r.status);
      if (r.status === 429) break;
    }
    return seen;
  };
  const control = await round(() => ({}));
  s.info(`no address header from the client: ${control.join(' ')}`);
  if (!control.includes(429)) {
    s.note('address headers through the local gateway', 'seven requests with no address header never met the brake, so this runtime kept no brake memory between them (a new worker per request?); the rounds that would tell which header the brake reads were skipped');
    return;
  }
  s.info(`so requests with no address header share one key here: the brake answered 429 on request ${control.length}`);
  const rounds = [
    ['cf-connecting-ip', (i) => ({ 'cf-connecting-ip': `2001:db8:${tag}::c${i}` })],
    ['x-real-ip', (i) => ({ 'x-real-ip': `2001:db8:${tag}::a${i}` })],
    ['X-Forwarded-For', (i) => ({ 'X-Forwarded-For': `2001:db8:${tag}::f${i}` })],
  ];
  const found = [];
  for (const [header, headersFor] of rounds) {
    const seen = await round(headersFor);
    const reached = !seen.includes(429);
    s.info(`${header} alone, a new value each time: ${seen.join(' ')}: ${reached ? 'the value the client wrote reached the brake' : `the value the client wrote did not decide the key (429 on request ${seen.length}): the gateway replaced or dropped it, or set a header the function reads first`}`);
    found.push(`${header} ${reached ? 'passes as the client wrote it' : 'does not'}`);
  }
  s.note('address headers through the local gateway (information only: the hosted gateway may differ; supabase/README.md, "Demo requests")', found.join('; '));
}
