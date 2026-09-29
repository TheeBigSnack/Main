// redeem_invite's answered miss through the real PostgREST (supabase/README.md
// step 5): an unknown code gets HTTP 400 and { code: 'P0002' }, and because
// the miss is answered rather than raised, PostgREST commits the row that
// counts it, so the eleventh wrong code in an hour gets P0005. The README
// asks the owner to check this by hand on the first deploy; the SQL tests
// cannot, since they call the function without PostgREST around it.

import { redeemInvite } from '../../extension/src/account.js';

export const title = 'redeem_invite counts wrong codes through PostgREST and throttles the eleventh';

const MISS = 'that invite code is not valid';
const THROTTLED = 'too many attempts; try again in an hour';

export async function run(s) {
  const guesser = await s.person('guesser', 'link');
  const answers = [];
  for (let i = 1; i <= 10; i += 1) {
    answers.push(await s.rpc('redeem_invite', { code: `WRONG${s.run}${i}`.toUpperCase(), display_name: null }, guesser.token));
  }
  const each = answers.map((r) => `${r.status} ${r.body && r.body.code}`);
  s.check(`ten wrong codes each get HTTP 400 { code: "P0002", message: "${MISS}" }`, answers.every((r) => r.status === 400 && r.body && r.body.code === 'P0002' && r.body.message === MISS), [...new Set(each)].join(', '));

  const kept = Number(s.sql(`select count(*) from public.invite_misses where user_id = ${s.lit(guesser.id)}`));
  s.check('all ten misses are still counted after their calls returned (PostgREST committed the answered 400)', kept === 10, `${kept} row(s) in invite_misses`);

  const eleventh = await s.rpc('redeem_invite', { code: `WRONG${s.run}11`.toUpperCase(), display_name: null }, guesser.token);
  s.info(`the eleventh wrong code: HTTP ${eleventh.status} ${s.brief(eleventh.body)}`);
  s.check(`the eleventh gets { code: "P0005", message: "${THROTTLED}" }`, eleventh.body && eleventh.body.code === 'P0005' && eleventh.body.message === THROTTLED, `HTTP ${eleventh.status}`);
  if (eleventh.status !== 400) s.info(`P0005 is raised, not answered, so PostgREST picks its status: ${eleventh.status} (supabase/README.md names none for it)`);

  // What the salesperson reads in Settings when the throttle holds.
  const shown = await redeemInvite('ANOTHERWRONG1', null, { url: s.url, anonKey: s.anonKey, session: guesser.session, fetchImpl: s.fetch });
  s.check("the extension's redeemInvite shows the throttle's sentence", !shown.ok && shown.error === THROTTLED, `${shown.status} ${shown.error}`);
}
