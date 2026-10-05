# Lot Current: positioning (internal, draft)

Written 2026-09-28 for Milestone 3, before any pilot feedback. Everything here is a hypothesis to test at Waynesburg. No invented testimonials, logos, reviews or statistics: every number below is either from our own live runs or is labelled as a guess.

## Who it is for

- **Buyer:** the used car manager (or general manager) of a franchise dealership, one rooftop at a time. They approve the tool, set the rules, and want to know who posted what and that sold cars came down.
- **User:** the salespeople who post their store's used cars on Facebook Marketplace from their own accounts, because Marketplace no longer takes vehicle listings from dealer Pages or partner feeds (since January 2023 and September 2021).
- **First market:** dealerships on Dealer Inspire websites in western Pennsylvania, starting with Ron Lewis CDJR Waynesburg and its sister stores in Cranberry and Pleasant Hills.

## The problem in their words

- Posting a car by hand takes several minutes of copying from the website, and salespeople stop doing it.
- Listings go stale: the car sells or the price drops on the website and the Marketplace listing still shows the old car or the old price, which makes the store look careless and invites complaints.
- Managers can't see who has what listed.
- The tools that "post for you" make people nervous: auto-posting is the kind of automated access Meta's Terms prohibit, and it is the salesperson's own account on the line.

## What Lot Current is

A Chrome extension. It reads the dealership's own website inventory, lets only pre-owned cars through, pre-fills the Marketplace vehicle listing (photos included) for the salesperson to check and publish, and re-reads the website every 3 hours to flag sold cars and price changes on the listings they made, with a button that opens the right listing ready to fix.

**One line:** Lot Current fills in the Marketplace listing from your website in about ten seconds. You click Publish, and it tells you the same day when a car sells or its price changes.

## Why it is different (the angle: careful and accurate)

| | Auto-posting tools | Lot Current |
|---|---|---|
| Who publishes | The tool, on a schedule | The salesperson, every time |
| What gets listed | Whatever is in the feed | Only cars the website says are pre-owned, at your store, with photos and a price |
| Price | Often set in the tool | Always the website price; changes only mirror the website |
| Sold cars | Depends | Flagged within one rescan (3 hours while Chrome is open), with the listing opened for you |
| Description | Templates or free text | Written from the car's listed facts on the website (not copied from its write-up), checked against them, reviewed by the salesperson |
| Facebook login | Some ask for it | Never. No passwords, cookies or tokens; no extra accounts; no tricks |
| The dealership | Sometimes hidden | Named in every description, with the salesperson's role |

Other tools in this space list at roughly $39 to $1,299 a month as of September 2026 (owner's notes; not for customer-facing copy without checking).

## What we can say, and what we can't

Say:
- "You click Publish. Lot Current never does." (True by construction: there is no code for it and a test that fails if any appears.)
- "Only pre-owned cars, only at your store, only at the website price."
- "Sold cars flagged the same day." (While Chrome is open, with rescans on; say that when asked.)
- "On the live form at Waynesburg, every field filled with nothing left over." (Our own live runs on 2026-09-27; say "in our tests", not "always".)
- "Not affiliated with Meta Platforms, Inc."

Don't say (until the attorney answers the questions in `legal/questions-for-attorney.md`):
- Anything that sounds like Meta approval, partnership or compliance.
- "Safe", "allowed", "compliant", or any promise about what will happen to a salesperson's account. The honest line: having a person click Publish is the safest design available, not a guarantee.
- A slogan built on the word "bot" (asked in the attorney questions).
- Any number we did not measure: time saved per week, more leads, more sales.

## Proof we can build honestly during the pilot

The extension records, with the dealer's agreement (pilot agreement section 2): time per post, which form fields could not be filled, how long sold cars and price changes stayed on the listings, and posts per salesperson. The Numbers tab exports them as a CSV. Those, confirmed by the manager, become the first numbers in the sales sheet, with the store's written permission (pilot agreement section 3).

## Pricing hypothesis

From `marketing/pricing.json` (one config, quoted everywhere): **$149 per rooftop per month**, five salespeople included, $20 a month per extra salesperson, a **30-day** free pilot, and a founding-dealer rate of **$99** a month for the first five stores for their first year. Reasons and what would change them are in that file. Billing is Milestone 5.

## Channels (from PLAN.md)

In-person demos (the 10-minute script in `demo-script.md`), the DealerRefresh forum, LinkedIn outreach to used car managers, local dealer association events. Track demos to pilots to paid stores, time per post, and how long sold cars stay listed.
