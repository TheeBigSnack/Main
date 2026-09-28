DRAFT: starting point for attorney review. Not legal advice.

# Chrome Web Store: privacy practices and Limited Use

Answers for the Developer Dashboard "Privacy practices" tab, plus the single-purpose and permission justifications the review asks for. Keep them in step with the manifest and the Privacy Policy.

## Single purpose

Lot Sync helps a car dealership salesperson prepare Facebook Marketplace listings for the dealership's pre-owned vehicles from the dealership's own website inventory, and tells them when a listed car sold or changed price. The person publishes every listing.

## Permission justifications

One row per pattern in `extension/manifest.json`.

| Permission | Why |
|---|---|
| `activeTab` | To read the inventory search on the dealership website tab the user is looking at when they click Scan |
| `scripting` | To run the scan code in that tab, and to fill in the Marketplace create-listing form when the user clicks Post |
| `storage` | Scans, settings, the user's posted list and the usage numbers below, kept locally per website. The user's profile (name, role, dealership, price basis, note, cap, listing defaults, Terms acceptance) is kept in Chrome's sync storage under the user's own Google account and is removed by "Forget my synced profile" in Settings |
| `sidePanel` | The guided post flow runs in the side panel so it stays open while the user moves between the dealership tab and the Marketplace tab |
| `alarms` | Re-reads the dealership website every 3 hours while Chrome is open, only for a website the user allowed in the set-up wizard, to keep the to-do count on the toolbar icon current. Never touches Facebook |
| `notifications` | A desktop notification when a background rescan adds to the user's to-do list (a sold car or a price change on the user's own listings). The user can turn it off in Settings |
| Host `https://www.facebook.com/marketplace/*` | To fill the vehicle listing form on the create-listing page the user opened, to fill the new price on the edit page the user opened, and to notice when the tab shows the published listing's address. No other Facebook pages are read |
| Host `https://vehicle-images.carscommerce.inc/*` | To download the car's own photos from the dealership's image host so they can be attached to the form |
| Optional host `https://vpic.nhtsa.dot.gov/*` | Requested when the user clicks "Check with NHTSA": the free government VIN decode, compared with what the website says |
| Optional host `https://*/*` | Optional; the set-up wizard requests only the chosen dealership's website origin and its inventory-service origin, for background rescans. Nothing else is ever requested under this pattern |

## Usage numbers (mirrors the Privacy Policy)

| Data | Where it lives | Why |
|---|---|---|
| Usage numbers: when a post started and ended and its outcome, which form fields could not be filled, hours until a flagged sold car or price change was fixed, and the salesperson name from Settings | Kept in the user's browser; leaves it only as the CSV the user chooses to export. Deleted by "Clear the numbers" in the Numbers tab and by "Clear everything for this website" in Settings, and pruned automatically to the newest 500 entries per list and nothing older than 90 days (open to-do items excepted) | Pilot check-ins and, from Milestone 4, the manager view |

## Data use disclosures (tick as applicable)

- Personally identifiable information: **Yes**, the user's name and role (typed into Settings, used in the listing sign-off) and, from Milestone 4, email for sign-in.
- Health, financial and payment information: **No** in the extension. (Billing runs on the website through Stripe, not the extension.)
- Authentication information: **No**. Lot Sync never collects Facebook passwords, cookies or tokens. (Milestone 4: a magic-link session for Lot Sync's own account.)
- Personal communications: **No**.
- Location: **No** (the dealership's city and ZIP, typed by the user, are business data).
- Web history: **No**.
- User activity: **No** tracking of clicks or browsing. The extension records only the listings the user chooses to record and the usage numbers above, which stay in the user's browser unless the user exports the CSV.
- Website content: **Yes**: vehicle inventory data from the dealership's website, and the fields of the Marketplace form the user is filling in.

## Certifications (Limited Use)

We certify that:
- Data is not sold to third parties, outside of the approved use cases.
- Data is not used or transferred for purposes unrelated to the item's single purpose.
- Data is not used or transferred to determine creditworthiness or for lending purposes.

## Limited Use statement (for the listing and the Privacy Policy)

Lot Sync's use of information received from the dealership website and from the Marketplace form is limited to preparing and maintaining the user's own vehicle listings. Vehicle facts are sent to our rewrite service (and on to Anthropic's API) only when the dealership enables the description writer. No Facebook account data is collected. See the full Privacy Policy at [URL].

## Remote code

None. All code ships in the extension package; the optional rewrite service returns text, not code.

## Notes for the listing text

Use "Facebook" and "Marketplace" only as plain names. No Meta logos or brand colours in icons or screenshots. State "Not affiliated with Meta Platforms, Inc." in the description. Screenshots must not show real customer data or a real person's Facebook account; use the mock form or blurred fields.
