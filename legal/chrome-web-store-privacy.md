DRAFT: starting point for attorney review. Not legal advice.

# Chrome Web Store: privacy practices and Limited Use

Answers for the Developer Dashboard "Privacy practices" tab, plus the single-purpose and permission justifications the review asks for. Keep them in step with the manifest, the Privacy Policy and `docs/data-inventory.md`, which lists everything the extension stores or sends.

## Single purpose

Lot Current helps a car dealership salesperson prepare Facebook Marketplace listings for the dealership's pre-owned vehicles from the dealership's own website inventory, and tells them when a listed car sold or changed price. The person publishes every listing.

## Permission justifications

One row per pattern in `extension/manifest.json`.

| Permission | Why |
|---|---|
| `activeTab` | To read the inventory search on the dealership website tab the user is looking at when they click Scan |
| `scripting` | To run the scan code in that tab; to fill in the Marketplace create-listing form Lot Current opens when the user clicks Open the Marketplace form (or, for Open the form and check fields only, to list that form's fields without filling them) and, in a queue the user started with Post selected or Post the next N, the form of each car that passes every check, without another click, the next one once the user has published the previous one; and, for a to-do item the user opens, to read the Marketplace page in the tab Lot Current opened for it and put the new price into the listing's edit form |
| `storage` | Scans, settings, the user's posted list and the usage numbers below, kept locally per website, and the Lot Current sign-in session, kept on this computer only. The user's profile (name, role, closing line, dealership name and address, the stores ticked, price basis, note, cap, listing defaults, the rewrite-service address and whether it is on, Terms acceptance) is kept in Chrome's sync storage under the user's own Google account and is removed by "Forget my synced profile" in Settings |
| `sidePanel` | The guided post flow runs in the side panel so it stays open while the user moves between the dealership tab and the Marketplace tab |
| `alarms` | Re-reads the dealership website every 3 hours while Chrome is open, only for a website the user allowed in the set-up wizard, to keep the to-do count on the toolbar icon current, and, while the user is signed in to a Lot Current account, sends that rescan's results (the posted list, post attempts, to-do items and the scan's counts) to the dealership's records in our database (Supabase). While signed in, also tries a sync again a minute after our server asked it to wait (more than a dozen syncs in a minute). Never touches Facebook |
| `notifications` | A desktop notification when a background rescan adds to the user's to-do list (a sold car or a price change on the user's own listings). The user can turn it off in Settings |
| Host `https://www.facebook.com/marketplace/*` | To fill the vehicle listing form and attach the car's photos on the create-listing page Lot Current opens for a post (or, for Open the form and check fields only, to list that form's fields without filling them); to fill the new price on the listing's edit form; to notice when the tab shows the published listing's address; and, while a to-do item the user opened (a sold car to take down or a price change) is open, to read every 1.5 seconds the Marketplace page shown in the tab Lot Current opened for it (the listing, or Marketplace's Your listings page when no listing link was saved) for its title, the prices on it and a sold or unavailable sign, so the side panel can tell the user when the change shows. What is read from those pages stays in the side panel while that item is open and is sent nowhere. Lot Current reads only the tab it opened for a post or a to-do item, while that post or item is open; pages outside facebook.com/marketplace/ are never read |
| Host `https://vehicle-images.carscommerce.inc/*` | To download the car's own photos from the dealership's image host so they can be attached to the form, or saved as files in the user's Downloads folder when the user clicks Download photos |
| Optional host `https://vpic.nhtsa.dot.gov/*` | Requested when the user clicks "Check with NHTSA": the free government VIN decode, compared with what the website says |
| Optional host `https://*/*` | Optional; never requested as such. The set-up wizard requests only the chosen dealership's website origin and its inventory-service origin, for background rescans; the side panel requests the same two origins, only when the user clicks Post, Post the next N or Rescan the website in its own list, or Allow reading on a post it stopped for that permission, so it can re-check the car or rescan without the dealership tab; it also requests only the https servers the car being posted keeps its photos on, when the user clicks to fill the form or download the photos. Nothing else is ever requested under this pattern |

## Usage numbers (mirrors the Privacy Policy)

| Data | Where it lives | Why |
|---|---|---|
| Usage numbers: when a post started and ended and its outcome, the car's VIN and name, which form fields could not be filled, the to-do items (a sold car to take down or a price change on the user's own listings, with the car's VIN and name, when it was flagged and fixed and, for a price change, the old and new price), and the salesperson name from Settings | Kept in the user's browser. Deleted by "Clear the numbers" in the Numbers tab (the to-do items still open and a post under way stay until they end; while the user is signed in, so do the to-do items closed since the last sync, until the next sync sends them) and by "Clear everything for this website" in Settings, and pruned automatically to the newest 500 entries per list and nothing older than 90 days (open to-do items excepted). When the user is signed in to a Lot Current account, the post attempts and to-do items (not the form-field records) also sync to the dealership's records in our database (Supabase), where the user's post attempts are seen by the user and the dealership's managers, and the to-do items by every member of the dealership; otherwise they leave the browser only as the CSV the user chooses to export | Pilot check-ins and the manager view |

## What the extension sends, and to whom (mirrors `docs/data-inventory.md`)

| When | What | To |
|---|---|---|
| Each scan, the background rescans the user allowed, and the start of each post | Reads of the inventory: the website's own inventory search, or, on a website read through its standard vehicle data, its used-inventory pages, each car's page (and, until a car's page is found, the other links on the website its card carries with that car's VIN, such as a financing form) and, when the list holds more cars than it links, its robots.txt and sitemaps, or, on a DealerOn or Dealer.com website, the inventory list its own pages load, page by page, and the page of a car that left the list; at post time, the car's full record | The dealership's website and the inventory search it uses |
| The user fills in a listing form or clicks Download photos; the side panel's review screen for a car | A request for each of the car's photos, without cookies; on the review screen, the photos shown as pictures, the way any web page shows a picture, so the user can pick which ones to post (no permission is needed for that, and nothing is downloaded or kept) | The photo servers the dealership's website names for the car's photos, which may belong to another company. An https server the extension may not read yet is asked for in Chrome's own prompt, from the user's click; after a no, its photos are not requested |
| The user clicks "Check with NHTSA" | The VIN | NHTSA's free VIN decoder |
| The user signs in and joins a dealership (only once Lot Current accounts are set up) | The email address, the emailed code, the invite code and the name from Settings | Our database host, Supabase |
| While signed in: after each scan (from the popup, or a rescan the extension runs in the background, automatic or asked for from the side panel), after each post, price update or take-down the user records, when set-up finishes, at sign-in or on joining a dealership, and on "Sync now"; a sync our server asked to wait (more than a dozen in a minute) is tried again a minute later | The user's posted list (VIN, car name, price, times, listing link, salesperson name), post attempts and to-do items (with, for a price change, the old and new price), and each scan's counts | Our database (Supabase), for the user's dealership |
| Only with the description writer turned on in Settings | The car's facts (year, make, model, trim, mileage, stock number, colours, body, engine, transmission, drivetrain, fuel type, features, the Carfax flags and the website description's own sentences), the dealership's name and city, the user's name and role and the price note; for a colour guess, up to four photo addresses and the list of colour words. With either, the dealership's website address, which our rewrite service uses to know which dealership the request is for and does not pass on. The VIN and the price are not among the fields | Our rewrite service (a Supabase function, or a self-hosted one at the address in Settings), and on to Anthropic's API |

Nothing goes to Facebook: the extension fills in the form in the user's own tab, and the user publishes.

## Data use disclosures (tick as applicable)

- Personally identifiable information: **Yes**, the user's name and role and any closing line they write (typed into Settings, used in the listing sign-off; a closing line can hold a phone number) and, once Lot Current accounts are set up, the email address used to sign in and the name given when joining a dealership.
- Health, financial and payment information: **No** in the extension. (Billing runs in the manager view through Stripe, not in the extension.)
- Authentication information: pending. Lot Current never collects Facebook passwords, cookies or tokens. For Lot Current's own account the user types an emailed sign-in code, and the extension keeps the session's access and refresh tokens on this computer; for a self-hosted description writer it keeps the key typed in Settings. [Pending attorney answer: questions-for-attorney.md 8.1]
- Personal communications: **No**.
- Location: pending. The extension reads no device location; the dealership's city, state and ZIP go into listings; when the user is signed in, requests to our database host carry the user's IP address, which its logs keep. [Pending attorney answer: questions-for-attorney.md 8.2]
- Web history: pending. The extension keeps the dealership website's address and the address of each Marketplace listing the user posted, and reads the Marketplace tab's address while a post is open; it keeps no list of pages visited. [Pending attorney answer: questions-for-attorney.md 8.3]
- User activity: pending. No clicks, keystrokes or scrolling are recorded. The extension records the listings the user chooses to record and the usage numbers above (post timings and outcomes, fields that could not be filled, when to-do items were fixed), which sync to the dealership's records when the user is signed in. [Pending attorney answer: questions-for-attorney.md 8.4]
- Website content: **Yes**: vehicle inventory data from the dealership's website; the fields of the Marketplace form the user is filling in (for Open the form and check fields only, the names of the form's fields); and, while a to-do item is open, the title, prices and sold or unavailable sign of the Marketplace page in the tab Lot Current opened for it (the listing, or the user's Your listings page when no listing link was saved), kept only while that item is open and sent nowhere.

## Certifications (Limited Use)

We certify that:
- Data is not sold to third parties, outside of the approved use cases.
- Data is not used or transferred for purposes unrelated to the item's single purpose.
- Data is not used or transferred to determine creditworthiness or for lending purposes.

## Limited Use statement (for the listing and the Privacy Policy)

Lot Current's use of information received from the dealership's website and from the Marketplace form is limited to preparing and maintaining the user's own vehicle listings. Vehicle facts, with the dealership's name and city, the user's name and role and the price note, are sent to our rewrite service (and on to Anthropic's API) only when the description writer is turned on in Settings. When the user signs in to a Lot Current account, the user's posted list, post attempts, to-do items and scan counts sync to their dealership's records in our database (Supabase). No Facebook account data is collected. See the full Privacy Policy at [URL].

## Remote code

None. All code ships in the extension package; the optional rewrite service returns text, not code.

## Notes for the listing text

Use "Facebook" and "Marketplace" only as plain names. No Meta logos or brand colours in icons or screenshots. State "Not affiliated with Meta Platforms, Inc." in the description. Screenshots must not show real customer data or a real person's Facebook account; use the mock form or blurred fields.
