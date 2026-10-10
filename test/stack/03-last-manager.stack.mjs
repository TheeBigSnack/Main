// keep_a_manager through the real PostgREST (supabase/README.md, "Who can
// see and do what"): the last manager can neither step down nor leave, and
// the request the manager page's Team card sends gets the trigger's P0006.
// It records the HTTP status and body PostgREST really gives for a raised
// P0006, and holds the page to showing error.message: supabase-js hands the
// page PostgREST's JSON body as `error`, and manager.js's onTeam throws
// error.message into the Team card's line. With a second manager in place
// the first may step down, so the refusal is about the last manager only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redeemInvite, createInvite } from '../../extension/src/account.js';

export const title = 'The last manager cannot step down or leave (P0006), and the manager page shows why';

const P0006 = 'a dealership keeps at least one manager: make someone else a manager first';

export async function run(s) {
  const d = s.dealership('team');
  const account = (who) => ({ url: s.url, anonKey: s.anonKey, session: who.session, fetchImpl: s.fetch });
  const boss = await s.person('boss', 'code');
  const joined = await redeemInvite(d.managerCode, 'Only Manager', account(boss));
  if (!s.check('the only manager joins with the first-manager code', joined.ok && joined.membership.role === 'manager', joined.ok ? joined.membership.role : `${joined.status} ${joined.error}`)) return;

  // The Team card's requests, as supabase-js sends them (manager.js onTeam):
  // update({ role }) or delete(), .eq('user_id').eq('dealership_id').select('user_id').
  const row = (who) => `/rest/v1/memberships?user_id=eq.${who.id}&dealership_id=eq.${d.id}&select=user_id,role`;
  const stepDown = await s.rest('PATCH', row(boss), { token: boss.token, body: { role: 'salesperson' }, prefer: 'return=representation' });
  s.info(`PostgREST's answer to the last manager stepping down: HTTP ${stepDown.status} ${s.brief(stepDown.body)}`);
  const said = stepDown.body && typeof stepDown.body === 'object' ? stepDown.body : {};
  s.check(`stepping down is refused with { code: "P0006", message: "${P0006}" }`, said.code === 'P0006' && said.message === P0006, `HTTP ${stepDown.status}`);

  const leave = await s.rest('DELETE', row(boss), { token: boss.token, prefer: 'return=representation' });
  s.info(`PostgREST's answer to the last manager leaving: HTTP ${leave.status} ${s.brief(leave.body)}`);
  s.check('leaving is refused with P0006 too', leave.body && leave.body.code === 'P0006', `HTTP ${leave.status}`);

  const still = await s.rest('GET', row(boss), { token: boss.token });
  s.check('they are still the manager afterwards', Array.isArray(still.body) && still.body.length === 1 && still.body[0].role === 'manager', `HTTP ${still.status} ${s.brief(still.body)}`);

  // The manager page: onTeam throws error.message, and the Team card shows it after "Couldn't change the team: "
  // (manager.js builds that sentence as `said`, and says it in the status line instead when another dealership was picked meanwhile).
  const page = readFileSync(join(s.root, 'manager/manager.js'), 'utf8');
  const start = page.indexOf('async function onTeam(');
  const onTeam = start < 0 ? '' : page.slice(start, page.indexOf('\n}\n', start));
  const readsMessage = onTeam.includes('if (error) throw new Error(error.message);')
    && onTeam.includes("const said = `Couldn't change the team: ${(e && e.message) || e}`;")
    && onTeam.includes('state.teamError = said;');
  s.check("manager.js's onTeam shows the database's error.message in the Team card", readsMessage, readsMessage ? '' : 'onTeam no longer reads error.message the way this check expects: look at manager/manager.js');
  const line = typeof said.message === 'string' ? `Couldn't change the team: ${said.message}` : 'no message in the answer';
  s.check("the Team card's line would say why", line.includes('make someone else a manager first'), line);

  // The rule is about the last manager: with another one, stepping down works.
  const deputy = await s.person('deputy', 'link');
  const code = await createInvite(d.id, 'salesperson', account(boss));
  const joinedDeputy = code.ok ? await redeemInvite(code.code, 'Deputy', account(deputy)) : { ok: false, error: code.error };
  if (!s.check('a salesperson joins with a code the manager made', joinedDeputy.ok, joinedDeputy.ok ? '' : joinedDeputy.error)) return;
  const promote = await s.rest('PATCH', row(deputy), { token: boss.token, body: { role: 'manager' }, prefer: 'return=representation' });
  s.check('the manager makes them a manager (Make manager)', promote.status === 200 && Array.isArray(promote.body) && promote.body.length === 1 && promote.body[0].role === 'manager', `HTTP ${promote.status} ${s.brief(promote.body)}`);
  const stepDownNow = await s.rest('PATCH', row(boss), { token: boss.token, body: { role: 'salesperson' }, prefer: 'return=representation' });
  s.check('with a second manager in place, the first may step down', stepDownNow.status === 200 && Array.isArray(stepDownNow.body) && stepDownNow.body.length === 1 && stepDownNow.body[0].role === 'salesperson', `HTTP ${stepDownNow.status} ${s.brief(stepDownNow.body)}`);
}
