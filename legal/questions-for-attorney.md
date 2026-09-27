DRAFT: starting point for attorney review. Not legal advice.

# Questions for the attorney

Context: Lot Sync is a Chrome extension that reads a car dealership's own website inventory, helps a salesperson pre-fill a Facebook Marketplace vehicle listing that the salesperson publishes personally, and reports sold cars and price changes. The founder works in sales at Ron Lewis Chrysler Dodge Jeep Ram Waynesburg (Pennsylvania), which is the first pilot dealer. Drafts of the Terms, Privacy Policy, Dealer Subscription Agreement, Pilot Agreement, Posting Rules, Chrome Web Store disclosures and a trademark note are in this folder. Please review them all; the questions below are the ones we most need answered before the pilot starts (planned Oct 26, 2026).

## 1. Meta's Terms and Commerce Policies

- Meta's Terms prohibit accessing its products "using automated means" without permission. Lot Sync opens the create-listing page in the user's own browser, fills in the form fields and attaches photos; the user reviews and clicks Publish. It never clicks Publish, Update, Delete or Mark as sold, uses no delays, spoofing, proxies or extra accounts, and never handles Facebook credentials. Is form pre-fill with a person publishing an acceptable position under the Terms as written? How does it compare with existing dealer posting tools that auto-post?
- What is the exposure for Lot Sync (the company) and for the salespeople (personal accounts) if Meta disagrees, and how should the Terms, the Posting Rules and the marketing wording describe that risk honestly?
- Commerce Policies: Marketplace does not allow dealers to list new vehicles and requires vehicle listings to be accurate. Anything else in the vehicle-listing rules we should enforce in the software (e.g. what "condition" and "title status" must mean)?
- Marketing wording: may we say "a person publishes every post" and "no bots" as a differentiator? Anything to avoid?

## 2. The founder's employment at the pilot dealer

- The founder is employed in sales at Ron Lewis CDJR Waynesburg and wants to sell Lot Sync to that store, its sister stores and, later, competitors. Please review the employment agreement and handbook for moonlighting, conflict-of-interest, IP assignment ("work made for hire" or invention-assignment clauses that could reach software written on personal time), confidentiality, and any non-compete or non-solicit.
- Who owns the Lot Sync IP today, and what should the founder do (written acknowledgement from the employer? entity formation before further work?) to keep it clean.
- Selling to the employer: any disclosure, approval or arm's-length requirements; using the employer's website data for a personal product before a signed agreement.

## 3. Reading dealer websites' inventory search

- Lot Sync reads the same inventory search service the dealer's website uses (Cars Commerce, behind Dealer Inspire sites), from the dealer's own tab, with the dealer's written authorisation (Dealer Subscription Agreement section 2). Please review the Dealer Inspire / Cars Commerce website terms and any API terms for restrictions on this, and advise what the dealer's authorisation needs to say.
- Is it enough that the dealer authorises it, given the data is the dealer's own inventory published on its own site? What changes when we move to official inventory feeds later?

## 4. Advertising law for Marketplace posts

- Federal (FTC Act Section 5, and the FTC's used-car and advertising guidance) and Pennsylvania rules (Automotive Industry Trade Practices, 37 Pa. Code Chapter 301) for price display, documentation-fee disclosure and dealer identification in a Marketplace post. The dealership's website headline price includes a $490 doc fee; the software posts that price with a note "Price includes the $490 doc fee; tax and tags extra." Is that wording right, and what must appear in every listing (dealer name? licence number? "dealer" designation?).
- Who is liable if a salesperson posts a wrong price or fee statement: the dealer, the salesperson, the software provider? How should the Dealer Subscription Agreement allocate it?
- The dealership sets a default title status ("Clean") and condition ("Very good") that the software fills in on every listing unless the website's own text mentions a branded title; the salesperson can change it on the form before publishing. Is a dealer-wide default acceptable, and what process should back it (a title check per car, a written dealer policy, a record of who published)?

## 5. AI-written descriptions

- Descriptions can be drafted by an AI model (Claude, via Anthropic's API) from the dealer's own data, then checked by software rules and reviewed by the salesperson before publishing. What is Lot Sync's liability if a published description is inaccurate, and what disclaimer, review requirement or record-keeping reduces it? Any disclosure obligation about AI-generated ad copy?

## 6. Company matters

- Trademark clearance for "Lot Sync" / "LotSync" (see trademark-note.md), and whether to file an intent-to-use application.
- Entity formation (LLC in Pennsylvania?) and timing relative to the pilot and IP questions above.
- Insurance: technology errors and omissions and cyber liability; what limits are sensible for a pilot-stage product.
- Pennsylvania sales tax on software subscriptions (canned software / SaaS treatment) and what to collect from dealers.

## 7. Employees posting from personal accounts

- Dealers will ask salespeople to post from personal Facebook accounts (Meta no longer allows dealer Pages to list vehicles). Any employment-law, wage-and-hour or privacy concerns with that, and what should the dealer's policy and the Posting Rules say? Does the dealer need a written policy on what happens to listings when a salesperson leaves?

## After review

Once the attorney approves the Terms and Privacy Policy, the first-run wizard will require acceptance of both (Milestone 5 in PLAN.md).
