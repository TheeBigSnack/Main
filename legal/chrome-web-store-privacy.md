DRAFT: starting point for attorney review. Not legal advice.

# Chrome Web Store: privacy practices and Limited Use

Answers for the Developer Dashboard "Privacy practices" tab, plus the single-purpose and permission justifications the review asks for. Keep them in step with the manifest, the Privacy Policy and `docs/data-inventory.md`, which lists everything the extension stores or sends.

## Single purpose

Lot Sync helps a car dealership salesperson prepare Facebook Marketplace listings for the dealership's pre-owned vehicles from the dealership's own website inventory, and tells them when a listed car sold or changed price. The person publishes every listing.

## Permission justifications

One row per pattern in `extension/manifest.json`.

| Permission | Why |
|---|---|
| `activeTab` | To read the inventory search on the dealership website tab the user is looking at when they click Scan |
| `scripting` | To run the scan code in that tab, and to fill in the Marketplace create-listing form when the user clicks Post |
| `storage` | Scans, settings, the user's posted list and the usage numbers below, kept locally per website, and the Lot Sync sign-in session, kept on this computer only. The user's profile (name, role, dealership name and address, the stores ticked, price basis, note, cap, listing defaults, the rewrite-service address and whether it is on, Terms acceptance) is kept in Chrome's sync storage under the user's own Google account and is removed by "Forget my synced profile" in Settings |
| `sidePanel` | The guided post flow runs in the side panel so it stays open while the user moves between the dealership tab and the Marketplace tab |
| `alarms` | Re-reads the dealership website every 3 hours while Chrome is open, only for a website the user allowed in the set-up wizard, to keep the to-do count on the toolbar icon current. Never touches Facebook |
| `notifications` | A desktop notification when a background rescan adds to the user's to-do list (a sold car or a price change on the user's own listings). The user can turn it off in Settings |
| Host `https://www.facebook.com/marketplace/*` | To fill the vehicle listing form on the create-listing page the user opened, to fill the new price on the edit page the user opened, and to notice when the tab shows the published listing's address. No other Facebook pages are read |
| Host `https://vehicle-images.carscommerce.inc/*` | To download the car's own photos from the dealership's image host so they can be attached to the form, or saved as files in the user's Downloads folder when the user clicks Download photos |
| Optional host `https://vpic.nhtsa.dot.gov/*` | Requested when the user clicks "Check with NHTSA": the free government VIN decode, compared with what the website says |
| Optional host `https://*/*` | Optional; the set-up wizard requests only the chosen dealership's website origin and its inventory-service origin, for background rescans. Nothing else is ever requested under this pattern |

## Usage numbers (mirrors the Privacy Policy)

| Data | Where it lives | Why |
|---|---|---|
| Usage numbers: when a post started and ended and its outcome, the car's VIN and name, which form fields could not be filled, the to-do items (a sold car to take down or a price change on the user's own listings, with the car's VIN and name, when it was flagged and fixed and, for a price change, the old and new price), and the salesperson name from Settings | Kept in the user's browser. Deleted by "Clear the numbers" in the Numbers tab and by "Clear everything for this website" in Settings, and pruned automatically to the newest 500 entries per list and nothing older than 90 days (open to-do items excepted). When the user is signed in to a Lot Sync account, the post attempts and to-do items (not the form-field records) also sync to the dealership's records in our database (Supabase); otherwise they leave the browser only as the CSV the user chooses to export | Pilot check-ins and the manager view |

## What the extension sends, and to whom (mirrors `docs/data-inventory.md`)

| When | What | To |
|---|---|---|
| Each scan, and the background rescans the user allowed | Inventory searches, the car's full record at post time, and the car's photos | The dealership's website: its inventory search and image host |
| The user clicks "Check with NHTSA" | The VIN | NHTSA's free VIN decoder |
| The user signs in and joins a dealership (only once Lot Sync accounts are set up) | The email address, the emailed code, the invite code and the name from Settings | Our database host, Supabase |
| After a scan, a post, a price update or a take-down, while signed in | The user's posted list (VIN, car name, price, times, listing link, salesperson name), post attempts and to-do items (with, for a price change, the old and new price), and each scan's counts | Our database (Supabase), for the user's dealership |
| Only with the description writer turned on in Settings | The car's facts (year, make, model, trim, mileage, stock number, colours, body, engine, transmission, drivetrain, fuel type, features, the Carfax flags and the website description's own sentences), the dealership's name and city, the user's name and role and the price note; for a colour guess, up to four photo addresses and the list of colour words. With either, the dealership's website address, which our rewrite service uses to know which dealership the request is for and does not pass on. The VIN and the price are not among the fields | Our rewrite service (a Supabase function, or a self-hosted one at the address in Settings), and on to Anthropic's API |

Nothing goes to Facebook: the extension fills in the form in the user's own tab, and the user publishes.

## Data use disclosures (tick as applicable)

- Personally identifiable information: **Yes**, the user's name and role (typed into Settings, used in the listing sign-off) and, once Lot Sync accounts are set up, the email address used to sign in and the name given when joining a dealership.
- Health, financial and payment information: **No** in the extension. (Billing runs in the manager view through Stripe, not in the extension.)
- Authentication information: pending. Lot Sync never collects Facebook passwords, cookies or tokens. For Lot Sync's own account the user types an emailed sign-in code, and the extension keeps the session's access and refresh tokens on this computer; for a self-hosted description writer it keeps the key typed in Settings. [Pending attorney answer: questions-for-attorney.md 8.1]
- Personal communications: **No**.
- Location: pending. The extension reads no device location; the dealership's city, state and ZIP go into listings; when the user is signed in, requests to our database host carry the user's IP address, which its logs keep. [Pending attorney answer: questions-for-attorney.md 8.2]
- Web history: pending. The extension keeps the dealership website's address and the address of each Marketplace listing the user posted, and reads the Marketplace tab's address while a post is open; it keeps no list of pages visited. [Pending attorney answer: questions-for-attorney.md 8.3]
- User activity: pending. No clicks, keystrokes or scrolling are recorded. The extension records the listings the user chooses to record and the usage numbers above (post timings and outcomes, fields that could not be filled, when to-do items were fixed), which sync to the dealership's records when the user is signed in. [Pending attorney answer: questions-for-attorney.md 8.4]
- Website content: **Yes**: vehicle inventory data from the dealership's website, and the fields of the Marketplace form the user is filling in.

## Certifications (Limited Use)

We certify that:
- Data is not sold to third parties, outside of the approved use cases.
- Data is not used or transferred for purposes unrelated to the item's single purpose.
- Data is not used or transferred to determine creditworthiness or for lending purposes.

## Limited Use statement (for the listing and the Privacy Policy)

Lot Sync's use of information received from the dealership's website and from the Marketplace form is limited to preparing and maintaining the user's own vehicle listings. Vehicle facts, with the dealership's name and city, the user's name and role and the price note, are sent to our rewrite service (and on to Anthropic's API) only when the description writer is turned on in Settings. When the user signs in to a Lot Sync account, the user's posted list, post attempts, to-do items and scan counts sync to their dealership's records in our database (Supabase). No Facebook account data is collected. See the full Privacy Policy at [URL].

## Remote code

None. All code ships in the extension package; the optional rewrite service returns text, not code.

## Notes for the listing text

Use "Facebook" and "Marketplace" only as plain names. No Meta logos or brand colours in icons or screenshots. State "Not affiliated with Meta Platforms, Inc." in the description. Screenshots must not show real customer data or a real person's Facebook account; use the mock form or blurred fields.
