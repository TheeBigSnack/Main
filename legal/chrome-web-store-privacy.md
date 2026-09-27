DRAFT: starting point for attorney review. Not legal advice.

# Chrome Web Store: privacy practices and Limited Use

Answers for the Developer Dashboard "Privacy practices" tab, plus the single-purpose and permission justifications the review asks for. Keep them in step with the manifest and the Privacy Policy.

## Single purpose

Lot Sync helps a car dealership salesperson prepare Facebook Marketplace listings for the dealership's pre-owned vehicles from the dealership's own website inventory, and tells them when a listed car sold or changed price. The person publishes every listing.

## Permission justifications

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | To read the inventory search on the dealership website tab the user is looking at when they click Scan, and to fill in the Marketplace create-listing form when the user clicks Post |
| `storage` | Scans, settings and the user's posted list, kept locally per website |
| `sidePanel` | The guided post flow runs in the side panel so it stays open while the user moves between the dealership tab and the Marketplace tab |
| Host `https://www.facebook.com/marketplace/*` | To fill the vehicle listing form on the create-listing page the user opened, and to notice when the tab shows the published listing's address. No other Facebook pages are read. |
| Host `https://vehicle-images.carscommerce.inc/*` | To download the car's own photos from the dealership's image host so they can be attached to the form |
| (Milestone 2) `optional_host_permissions` for the dealer website, `alarms`, `notifications` | Automatic rescans every 3 hours and a badge/notification with the to-do count, only after the user grants the site permission in the wizard |

## Data use disclosures (tick as applicable)

- Personally identifiable information: **Yes**, the user's name and role (typed into Settings, used in the listing sign-off) and, from Milestone 4, email for sign-in.
- Health, financial and payment information: **No** in the extension. (Billing runs on the website through Stripe, not the extension.)
- Authentication information: **No**. Lot Sync never collects Facebook passwords, cookies or tokens. (Milestone 4: a magic-link session for Lot Sync's own account.)
- Personal communications: **No**.
- Location: **No** (the dealership's city and ZIP, typed by the user, are business data).
- Web history: **No**.
- User activity: **No** tracking of clicks or browsing. The extension records only the listings the user chooses to record.
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
