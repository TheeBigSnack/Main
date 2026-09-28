# Launch checklist: from the end of the pilot to the first paying dealers

Everything between the pilot's last week and the first invoice, grouped by who does it. Each item has a "done when" so nobody argues about whether it is finished. No dates: the order is the plan, and the milestones in `PLAN.md` say roughly when. The rules in `CLAUDE.md` apply to every item.

The pilot itself ends when `PILOT.md`'s three criteria are met and the manager has confirmed the numbers. This list starts there.

## Legal

- [ ] **Attorney answers received**, at least on sections 1 (Meta's Terms and how to describe the risk), 2 (the founder's employment at the pilot dealer) and 4 (advertising law and the price note) of `legal/questions-for-attorney.md`. Done when: each answer is filed next to its question and the product copy, the posting rules and the marketing wording say what the attorney said we may say.
- [ ] **Terms of Service and Privacy Policy final.** Done when: `legal/terms-of-service.md` and `legal/privacy-policy.md` carry the attorney's changes and no "DRAFT" line, they are hosted at real addresses, and `extension/src/legalLinks.js` has those addresses and a new `version` so every salesperson accepts the final texts.
- [ ] **Posting rules final.** Done when: `legal/posting-rules.md` has the attorney's wording and `test/postingRules.test.js` still passes (the wizard shows the same text).
- [ ] **Dealer Subscription Agreement and Schedule A ready to sign.** Done when: every bracket is either filled or is a field the dealer fills, the attorney has read section 2 (the dealer's authorisation to read its website) and the liability split for wrong prices, and Schedule A is blank of any pilot value.
- [ ] **Entity formed.** Done when: the entity named in the Terms, the Privacy Policy and the agreements exists, and "[Lot Sync entity name]" appears in no legal document.
- [ ] **Insurance in place.** Done when: technology errors and omissions and cyber liability policies are bound at the limits the attorney thought sensible for this stage, and the certificate is where a dealer can be shown it.
- [ ] **Trademark question answered.** Done when: the attorney has said whether "Lot Sync" is clear to use and whether to file, and that decision is recorded in `legal/trademark-note.md`.
- [ ] **Sales tax question answered.** Done when: the attorney has said what to collect on subscriptions in the state we sell from, and Stripe is set up to do it.

## Product

- [ ] **The M2 live checks done on a real site**: the wizard's permission step, a background rescan with the badge and the notification, one price update and one take-down on real listings (`PLAN.md` M2). Done when: each is ticked in `PILOT.md`'s "Once, before the first pilot" list and any fix is in `listingSigns.js` or `formMap.js` only.
- [ ] **The top pilot field failure fixed.** Done when: the Pilot tab's field table shows "Every field filled every time" for the last week of the pilot, or the remaining failure is one the form map cannot fix and the help doc tells people what to do by hand.
- [ ] **The photo-host permission decision made** (`PLAN.md`, "Needs the owner's OK"). Done when: the owner has decided whether the static image host stays in the manifest or is requested at post time from the salesperson's own click; the manifest, `legal/chrome-web-store-privacy.md`, `store/listing.md` and `test/manifest.test.js` agree; and it was checked by hand that photos still attach.
- [ ] **Chrome Web Store submission, unlisted.** Done when: every box in the "Before submitting" list in `store/listing.md` is ticked, the zip from `npm run pack` is uploaded with the five real screenshots, visibility is Unlisted, and the review has passed or every rejection reason is logged and fixed.
- [ ] **Install and update from the Web Store.** Done when: `docs/help.md` and the day-0 onboarding email describe the store install for new dealers, with the zip steps kept for anyone still on it.
- [ ] **The second platform chosen and started** (`docs/next-platform.md`). Done when: the memo names the platform, the reason and the first dealer, and an adapter file exists under `extension/adapters/` with a probe verified on that dealer's real site and tests on real records from it.
- [ ] **Adapter contract complete** (`PLAN.md`, "Wider use", M6). Done when: probe, search and normalise live inside each adapter, `src/` has no platform-specific code left, and `test/adapters.test.js` covers both adapters.
- [ ] **Tests green on the machine that ships zips.** Done when: `npm test` and `npm run test:e2e` pass locally and in the CI workflow on the branch that is packed.
- [ ] **CHANGELOG and README current.** Done when: the version in the manifest, `package.json` and `package-lock.json` is one number, the CHANGELOG has that version at the top, and the README's test count matches `npm test`.

## Accounts and billing

- [ ] **Supabase project live** (`PLAN.md` M4). Done when: magic-link sign-in works for two people at one dealership, row-level security tests show one dealership cannot read another's rows, and the rewrite endpoint refuses unauthenticated calls and stops at the monthly cap.
- [ ] **The posted registry syncs.** Done when: two salespeople on two machines see the same posted registry, and a car posted on one shows on the other after its next scan.
- [ ] **The manager view works** (`manager/`). Done when: a manager at the pilot dealer signs in and sees posts per salesperson, sold cars still listed and for how long, and price mismatches, with the numbers matching the salespeople's Pilot tabs for the same week.
- [ ] **Stripe set up** (`PLAN.md` M5). Done when: a per-rooftop subscription with the free pilot period and the customer portal exist, a test-mode dealer can subscribe, start the pilot period and manage billing without help, and the prices are the ones in `marketing/pricing.json`.
- [ ] **Pricing confirmed.** Done when: a dealer has agreed to pay a price in writing, `marketing/pricing.json` has `"hypothesis": false` and the same numbers, and `test/marketing.test.js` still passes.
- [ ] **The per-salesperson cap follows the account, not the browser** (`PLAN.md`, "Wider use", M4). Done when: the same person on two machines shares one day's count.
- [ ] **Retention runs.** Done when: a dealership's records are deleted within the 30 days the agreements promise after a subscription or pilot ends, and the deletion was tried once on a test dealership.

## Sales

- [ ] **Positioning confirmed by the pilot numbers.** Done when: `marketing/positioning.md` says which of its hypotheses the pilot supported and which it did not, with the numbers from the manager-confirmed CSVs, and nothing in it is still labelled a guess that the pilot could have settled.
- [ ] **The sales sheet carries only permitted numbers.** Done when: every number in `marketing/sales-sheet.md` comes from the pilot CSVs, the manager has confirmed it, the store has given written permission under pilot agreement section 3 (or the store is not named), and `test/marketing.test.js` passes.
- [ ] **Demo script rehearsed.** Done when: the 10-minute demo in `marketing/demo-script.md` has been run end to end twice on a dealership website that is not the pilot's, without publishing, and the "If something goes wrong" section covers everything that went wrong in rehearsal.
- [ ] **The pilot offer and onboarding emails updated.** Done when: `marketing/pilot-offer-email.md` and `marketing/onboarding-emails.md` describe the store install and the accounts, and every bracket is a field the sender fills.
- [ ] **The landing page live** (`site/`, `PLAN.md` M5). Done when: the page is at the real address, the demo form lands in an inbox or the database, the legal links resolve, and the page says "Not affiliated with Meta Platforms, Inc."
- [ ] **A pipeline sheet exists.** Done when: demos, pilots and paid dealers are tracked in one place with the source of each (in-person demo, forum, LinkedIn, association event), as `PLAN.md`'s launch plan asks.

## Support

- [ ] **The inbox exists.** Done when: `support@lotsync.example` is replaced by a real address in `docs/support.md`, `store/listing.md` and `extension/src/legalLinks.js`, mail to it reaches a named person, and a test message was answered.
- [ ] **The help doc is current.** Done when: `docs/help.md` names every button as the current popup and side panel label it (`test/docs.test.js` checks a list of them), covers the store install, and a pilot salesperson has read it and found nothing missing.
- [ ] **The log is running.** Done when: every request from the pilot is in the log in `docs/support.md`'s format, each with a first answer within one business day, and the weekly read of the log has produced at least one help-doc change or one fix.
- [ ] **The severity words are in use.** Done when: every log row has one of the three, and a "blocks posting" row shows a workaround in its first answer.

## Design partners

- [ ] **Three to five dealers agreed** (`PLAN.md` M6). Done when: each has signed the pilot agreement or the subscription agreement, named its manager and at least two salespeople, and its website has been scanned once by the owner to confirm the platform is one Lot Sync reads.
- [ ] **Sister stores first.** Done when: the pilot dealer's sister stores under the same group website have been offered the pilot before any outside dealer, and their answer is recorded in the pipeline sheet.
- [ ] **Each partner is active.** Done when: each partner dealer has at least two salespeople posting and one manager using the manager view, as M6's first criterion asks, and the partner list with usage numbers is what the M6 demo shows.
- [ ] **Each partner has done the set-up.** Done when: every salesperson has finished set-up, including the posting rules and the Terms, and has run one dry run (**Open the form and check fields only (nothing filled)**) with nothing under "Not found".
- [ ] **The next platform's first dealer is among them, or is named.** Done when: `docs/next-platform.md`'s output line is filled in with a dealer who has agreed to be the first on that platform.
- [ ] **A weekly check-in with each partner.** Done when: the check-in is in the calendar, the Pilot tab (or the manager view) numbers are collected each week, and the log and the pipeline sheet are updated from it.

## The line that says we are launched

Every item above is ticked, at least one dealer outside the pilot is paying through Stripe, and its salespeople post from the Web Store build with support answering within one business day.
