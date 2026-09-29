DRAFT: starting point for attorney review. Not legal advice.

# Lot Sync Privacy Policy

Last updated: [date]. [Lot Sync entity name] ("we") makes the Lot Sync browser extension and related services. This policy says what we collect, why, who processes it, how long we keep it and how to reach us.

## What we collect and why

| Data | Where it lives | Why |
|---|---|---|
| Dealership website inventory (vehicle records: VIN, year/make/model, price, mileage, photos, features, description, location, status) | In the User's own browser (`chrome.storage.local`), read from the dealership's public website each scan | To check each car is pre-owned and ready, to prepare listings, and to detect sold cars and price changes |
| Settings (salesperson name and role, dealership name, city, state, ZIP, price basis, price note, daily cap, listing defaults for title status and condition, rewrite-service address and key) | In the User's browser. The profile (name, role, dealership, price basis, note, cap, listing defaults, Terms acceptance) is also kept in Chrome's sync storage under the User's own Google account, so it follows the User's Chrome sign-in; the rewrite-service key never leaves the computer | To fill the listing and sign the description |
| Posted-listing registry (VIN, listing link the User saved or Lot Sync detected, posted price, times, salesperson name) | In the User's browser; from Milestone 4, also in our database, per dealership | To keep listings accurate and, for managers, to see who posted what |
| Scan summaries (counts and change lists) | In the User's browser; later, per-dealership in our database | Rescans and the manager view |
| Usage numbers: when a post started and ended and its outcome, which form fields could not be filled, hours until a flagged sold car or price change was fixed, and the salesperson name from Settings | Kept in the User's browser, pruned automatically to the newest 500 entries per list and nothing older than 90 days (open to-do items excepted); leaves it only as the CSV the User chooses to export | Pilot check-ins and, from Milestone 4, the manager view |
| Account details (from Milestone 4: email for magic-link sign-in, dealership membership, role) | Our database (Supabase) | Sign-in and access control |
| Billing details (from Milestone 5: dealership billing contact, subscription status) | Our payment processor (Stripe); we do not store card numbers | Billing |
| Rewrite requests (vehicle facts, dealership name and city, salesperson name and role, price note) | Sent to our rewrite service and on to Anthropic's API only when the dealership turns the feature on | To draft a description |
| Support messages (name, dealership, role, email, phone, and what the message says) | Our inbox and the support log | To respond |
| Demo requests from our website (name, dealership, dealership website, email, phone, message, and when and from which page it was sent) | Our database (Supabase), or our inbox when the form opens the visitor's own mail app instead | To respond |

We do **not** collect: Facebook passwords, cookies, session tokens, messages, buyer information, or anything from Facebook beyond the listing address the User saves or Lot Sync detects on the User's own tab. We do not track browsing outside the dealership website and the Marketplace create-listing page while the User is posting.

## Processors

- Anthropic (description drafts via the Claude API, only with the rewrite feature on; only vehicle facts and the sign-off details are sent). Anthropic's API usage policies apply.
- Supabase (database, authentication, edge functions) from Milestone 4.
- Stripe (billing) from Milestone 5.
- Hosting for the rewrite service and website: [provider].
- Chrome Web Store (distribution): Google's policies apply to the extension listing.

We do not sell personal data and do not use it for advertising.

## Retention

Browser data stays until the User clears it (Settings, "Clear everything for this website") or uninstalls. The usage numbers are deleted by "Clear the numbers" in the Numbers tab and by "Clear everything for this website" in Settings. Lot Sync also prunes them automatically each time it records one: each list (post attempts, form fills, to-do items) keeps its newest 500 entries and nothing older than 90 days, except open to-do items, which stay until they are closed. The profile in Chrome's sync storage (name, role, dealership, price basis, note, cap, listing defaults, Terms acceptance) is not removed by "Clear everything for this website"; "Forget my synced profile" in Settings removes it, and it also goes when the User clears their Chrome sync data. Saving Settings re-creates it. Database records for a dealership are deleted within 30 days of the subscription ending unless the law requires longer. Rewrite logs keep the vehicle's year, make and model and a cost figure, not the description. Support and billing records are kept as required for accounting and legal purposes.

## Security

Data in the browser is under the browser's protection. Our services use encrypted connections, per-dealership row-level access in the database and a shared key for the rewrite service. No method is perfect; report concerns to the contact below.

## Your choices and rights

Users can view and clear all local data in the extension. Customers can ask us to export or delete their dealership's records. Residents of states with privacy laws (and EU/UK residents, if we ever serve them) have rights of access, correction, deletion and portability; write to us. [Attorney: confirm which state laws apply given B2B use and Pennsylvania location.]

## Children

Lot Sync is for dealership staff, not for anyone under 18.

## Changes

We will post changes here and update the date; material changes will be notified to the Customer.

## Contact

[Lot Sync entity name], [postal address], [privacy email].

Lot Sync is not affiliated with Meta Platforms, Inc.
