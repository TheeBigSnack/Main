// Self-serve sign-up through the real PostgREST (supabase/README.md,
// "Self-serve sign-up"): closed, create_dealership refuses with P0008; opened
// by the owner in SQL, a signed-in person starts a dealership, becomes its
// manager and its free pilot starts; a website that already has a
// dealership is answered with HTTP 400 and P0009, and because that answer
// commits, the throttle counts it: the sixth try in an hour gets P0005, the
// check the README asks the owner to make by hand on the first deploy.
// The switch is set back to what it was, here and again by the runner.

import { syncOnce, describeSync } from '../../extension/src/accountFlow.js';

export const title = 'create_dealership: closed, opened, taken and throttled';

export async function run(s) {
  const founder = await s.person('founder', 'link');
  const website = `www.signup-${s.run}.example`;
  const origin = `https://${website}`;
  const form = { name: `Stack Signup Motors ${s.run}`, website, your_name: 'Stack Founder' };

  const closed = await s.rpc('create_dealership', form, founder.token);
  s.info(`sign-up closed: HTTP ${closed.status} ${s.brief(closed.body)}`);
  s.check('while sign-up is closed, create_dealership refuses with { code: "P0008" } and its sentence', closed.body && closed.body.code === 'P0008' && /^sign-up is not open/.test(String(closed.body.message)), `HTTP ${closed.status}`);

  s.sql('update public.signup_settings set open = true');
  try {
    const made = await s.rpc('create_dealership', form, founder.token);
    const answer = made.body && typeof made.body === 'object' ? made.body : {};
    if (!s.check('once the owner opens it, a signed-in person starts a dealership', made.status === 200 && answer.website_origin === origin && /^[0-9a-f-]{36}$/.test(String(answer.dealership_id)), `HTTP ${made.status} ${s.brief(made.body)}`)) return;
    s.check('its free pilot has started (pilot_ends_at is in the future)', Date.parse(answer.pilot_ends_at) > Date.now(), String(answer.pilot_ends_at));

    const id = answer.dealership_id;
    const membership = await s.rest('GET', `/rest/v1/memberships?select=role,name&dealership_id=eq.${id}&user_id=eq.${founder.id}`, { token: founder.token });
    s.check('the caller is its manager', Array.isArray(membership.body) && membership.body.length === 1 && membership.body[0].role === 'manager', `HTTP ${membership.status} ${s.brief(membership.body)}`);
    const plan = await s.rest('GET', `/rest/v1/subscriptions?select=status,pilot_ends_at&dealership_id=eq.${id}`, { token: founder.token });
    s.check("its subscriptions row, read with the manager's own token, says pilot", Array.isArray(plan.body) && plan.body.length === 1 && plan.body[0].status === 'pilot', `HTTP ${plan.status} ${s.brief(plan.body)}`);
    const synced = await syncOnce({ origin, deps: founder.deps });
    s.check("the new manager's extension syncs with it, on the pilot plan", synced.ok && synced.role === 'manager' && synced.state && synced.state.plan && synced.state.plan.state === 'pilot', describeSync(synced));

    // Someone else asks for the same website, spelled differently the first time.
    const latecomer = await s.person('latecomer', 'link');
    const again = { name: 'Stack Latecomer Motors', your_name: 'Stack Latecomer' };
    const spellings = [`HTTPS://WWW.SIGNUP-${s.run.toUpperCase()}.EXAMPLE/used-vehicles/`, website, website, website, website, website];
    const tries = [];
    for (const w of spellings) tries.push(await s.rpc('create_dealership', { ...again, website: w }, latecomer.token));
    const each = tries.map((r) => `${r.status} ${r.body && r.body.code}`).join(', ');
    s.info(`six tries for a taken website: ${each}`);
    s.check('a taken website gets HTTP 400 { code: "P0009" }, five times, however it is typed', tries.slice(0, 5).every((r) => r.status === 400 && r.body && r.body.code === 'P0009'), each);
    s.check('the sixth try in the hour gets HTTP 400 { code: "P0005" }', tries[5].status === 400 && tries[5].body && tries[5].body.code === 'P0005', `${tries[5].status} ${s.brief(tries[5].body)}`);
    const counted = Number(s.sql(`select count(*) from public.signup_attempts where user_id = ${s.lit(latecomer.id)} and outcome = 'taken'`));
    s.check('each taken answer was counted in signup_attempts (PostgREST committed the answered 400)', counted === 5, `${counted} row(s)`);
    const dealerships = Number(s.sql(`select count(*) from public.dealerships where website_origin = ${s.lit(origin)}`));
    s.check('and still one dealership has that website', dealerships === 1, `${dealerships}`);
  } finally {
    s.sql(`update public.signup_settings set open = ${s.signupOpenBefore ? 'true' : 'false'}`);
  }
}
