# Support for the first dealers

How support works for the pilot and the design-partner dealers. The commitment, from PLAN.md Milestone 6: **every support request is answered within one business day and logged.** "Answered" means a person replied with either the fix, a workaround, or what happens next and when to expect more. It does not mean the fix has shipped.

## The inbox

- Address: `support@lotsync.example` (a placeholder until the domain and the mailbox exist; change it here and fill in the `[support email]` brackets in `store/listing.md` together when it does. The extension itself shows no support address: Settings' **Report a problem** points people at the help doc, which points here).
- One person owns the inbox each business day. The owner reads it at the start and the end of the day at least.
- Salespeople may also send a report to their manager, who forwards it. The log records who it came from either way.
- Anything that arrives through another channel (a text, a call, a note at a demo) is written into the inbox by whoever received it, so the log has one source.

## What to ask for in every report

Reply with these four questions when any of them is missing. Most fixes need all four.

1. **The report from the panel.** When the side panel shows **Couldn't fill**, that list, or the text from **Copy report** on the dry run (**Open the form and check fields only (nothing filled)**). It says what the form showed, which is what the fix is made from. Ask also for **Copy problem report** (Settings, **Report a problem**): the version, website, adapter, last scan, last error and the last fill's field names, nothing personal.
2. **The version.** The first line of **Settings** in the popup: "Lot Sync <version> · form map <date>". A fix already shipped in a newer zip is the most common answer.
3. **The website.** The address of the dealership's used inventory page, and the tab the person was on when it happened.
4. **What was on screen.** In their own words: which button they clicked, what the panel said, what Facebook showed. A screenshot of the panel is welcome. A screenshot of Facebook is fine only with no messages, buyer names or account details in it.

Never ask for: a Facebook password, a cookie, a token, a two-factor code, a login link, or access to the person's Facebook account. See "What is never done" below.

## Severity, and what each gets

Three words, written in the log as they are here.

| Severity | Means | What it gets |
|---|---|---|
| **blocks posting** | A salesperson cannot get a car posted or a to-do item done with Lot Sync: the scan fails, the panel will not open the form, a field will not fill and cannot be filled by hand, the queue is stuck. | Worked on first. The answer carries the workaround the help doc gives (fill by hand from the **Copy** buttons, scan by hand, **Download photos**) so the person can keep working today. The fix goes into the next zip as soon as `npm test` and the end-to-end flows pass, with a CHANGELOG line. |
| **wrong data on a listing** | Something Lot Sync filled or wrote does not match the website: a price, a number in the description, a colour, the location, a title or condition default that was wrong for the car. | The first reply asks the salesperson to fix the listing on Facebook themselves the same day (Lot Sync never edits a listing) and confirms which cars are affected. Then the cause is found: the website record, the normaliser, the template or the form. A guardrail or test is added so it cannot come back quietly. |
| **cosmetic** | Wording, layout, a count that reads oddly, a hint that could be clearer. Nothing wrong reaches a listing and nothing is blocked. | Logged and answered. Fixed in a later release, batched with others. |

A report about a Facebook warning or a restricted account is not a severity: it is logged, the salesperson is told to stop posting and tell their manager (posting rule 9), and the owner is told the same day. No promise is made about what Facebook will do.

## The log

Kept as a table, one row per request, in a spreadsheet or in this file. Every row is filled in, even for a question that needed no fix.

| Date | Dealer | Who | What happened | The report | Severity | Fix commit | Answered when |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

- **Date**: when the request arrived.
- **Dealer**: the dealership, as named in its agreement. No dealer name goes into code, tests or user-facing copy because of a support case.
- **Who**: the salesperson or manager, and their role.
- **What happened**: one or two sentences in plain words.
- **The report**: the panel's report pasted in, or a link to it, plus the version line and the website.
- **Severity**: blocks posting, wrong data on a listing, or cosmetic.
- **Fix commit**: the commit hash and the zip version it shipped in, or "no fix needed" with the reason.
- **Answered when**: the date and time of the first reply. Must be within one business day of Date.

Once a week the log is read top to bottom: the top field failure goes into the pilot loop (`PILOT.md`), and anything asked twice goes into `docs/help.md`.

## Privacy requests

The privacy policy (`legal/privacy-policy.md`, "Your choices and rights") lets a dealership ask for its records to be exported or deleted, and a person ask for their own data to be deleted. There are three request types. The owner answers each with one function; the SQL, what each function removes and keeps, and how to hand over an export are in `supabase/README.md`, "Export or delete a dealership's data".

| Request | Who may ask | How to verify | What the owner runs |
|---|---|---|---|
| **Export a dealership's records** | A manager of that dealership | The request comes from, or is confirmed by a reply from, the email of an account that holds a manager membership of that dealership (the lookup query in the README shows each member's role and email). | `export_dealership`; the file goes to that address and nowhere else. |
| **Delete a dealership** | A manager of that dealership | As for an export, and then a phone call to the dealership's main number, taken from its own website, asking for that manager by name, to confirm before anything is deleted. A delete cannot be undone. | `delete_dealership` with the dealership's exact website origin as the confirm, then the Stripe customer by hand, then `forget_person` for its people when the request covers them. |
| **Forget a person** | The person themself | The request comes from, or is confirmed by a reply from, the email of their own Lot Sync account. Signing in is a link or code sent to that inbox, so control of it is control of the account. | `forget_person` with that email as the confirm. |

- Reply to the address on the account, never to a new address the request gives. A request that cannot be verified gets a reply saying what is needed, and nothing is run until it is.
- A salesperson who asks for the dealership's export or deletion is told that a manager must ask. A manager who asks to forget someone else is pointed at the manager view's Team card, where they can remove the member; the person's name stays on the dealership's records until the person asks themself.
- When the person is the last manager of a dealership, `forget_person` refuses. Write to the dealership to name a new manager first; if nobody is left, or the dealership is leaving too, the dealership is deleted first. The person's request is still finished within 30 days.
- The first reply goes out within one business day, like every request. The request is finished within 30 days of being verified: the same 30 days the policy gives for deleting a dealership's records after its subscription ends.
- Tell the person what the database cannot reach: their own browser (Settings, **Clear everything for this website** and **Forget my synced profile**), their listings on Facebook (theirs to delete; Lot Sync never does), and copies the dealership already holds.
- A request to correct data: a person corrects their own name and role in Settings (what their listings are signed with), and a manager corrects a member's name or role in the Team card. Anything else is corrected by the owner in SQL, after the same verification as an export.
- A person asking for a copy of their own data is answered by hand, within the same 30 days: their account email, their memberships and the rows that carry their user id, taken from `export_dealership` for each of their dealerships, and nobody else's rows.
- Log each request like any other: the request type in **What happened**, no severity (it is not a fault), and in **Fix commit** the function that was run and the counts it answered. Never the export itself, and nothing from it.

## Fixing

The weekly loop in `PILOT.md` applies to every dealer, not only the pilot:

1. Reproduce the report against the mock Marketplace form (`test/e2e/mock-marketplace.mjs`) or the mock dealer site (`test/e2e/mock-dealer-site.mjs`), adding the behaviour to the mock when it is new.
2. A Facebook field: fix it in `extension/facebook/formMap.js` (a name pattern) or `fillForm.js` (a behaviour), nowhere else. A listing page reading differently: `listingSigns.js`. A website record: the adapter under `extension/adapters/`.
3. `npm test`, then the end-to-end flow that covers it.
4. Commit, a line in `CHANGELOG.md`, `npm run pack`, and the new zip with the update steps from `docs/help.md` to every salesperson at every dealer on that version.

## What is never done in support

- **Never touch a salesperson's Facebook account.** Support never logs in as them, never takes remote control of a Facebook tab, never publishes, edits, marks sold or deletes a listing for them, and never asks them to hand over the account for "a quick look". If a listing must change, the salesperson changes it.
- **Never ask for passwords**, cookies, session tokens, two-factor codes or login links, for Facebook or for anything else. Lot Sync has no use for them, and a request for one is a sign something is wrong.
- Never ask for buyer names, messages or anything from Marketplace conversations.
- Never tell a person their account is safe, that a listing is allowed, or that Meta has signed off on anything. The honest line is in `docs/help.md`: a person clicking Publish is the safest design available, not a guarantee.
- Never put a dealer's name, address, fee, a person's name or a listing link into code, tests, prompts or user-facing copy. Worked examples go in `test/fixtures/` with the dealer's agreement, or nowhere.
- Never install anything on a salesperson's computer other than the zip, and never change their Chrome settings for them beyond the install steps.
- Never send a dealership's export to anyone but the verified manager who asked, and never run `delete_dealership` or `forget_person` for a request that has not been verified.

Lot Sync is not affiliated with Meta Platforms, Inc. Support speaks for Lot Sync only.
