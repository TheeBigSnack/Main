# Support for the first dealers

How support works for the pilot and the design-partner dealers. The commitment, from PLAN.md Milestone 6: **every support request is answered within one business day and logged.** "Answered" means a person replied with either the fix, a workaround, or what happens next and when to expect more. It does not mean the fix has shipped.

## The inbox

- Address: `support@lotsync.example` (a placeholder until the domain and the mailbox exist; change it here, in `store/listing.md` and in `extension/src/legalLinks.js` together when it does).
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

Lot Sync is not affiliated with Meta Platforms, Inc. Support speaks for Lot Sync only.
