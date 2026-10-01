DRAFT: starting point for attorney review. Not legal advice.

# Questions for the attorney

Context: Lot Current is a Chrome extension that reads a car dealership's own website inventory, helps a salesperson pre-fill a Facebook Marketplace vehicle listing that the salesperson publishes personally, and reports sold cars and price changes. The founder works in sales at Ron Lewis Chrysler Dodge Jeep Ram Waynesburg (Pennsylvania), which is the first pilot dealer. Drafts of the Terms, Privacy Policy, Dealer Subscription Agreement, Pilot Agreement, Posting Rules, Chrome Web Store disclosures and a trademark note are in this folder. Please review them all; the questions below are the ones we most need answered before the pilot starts (planned Oct 26, 2026).

## 1. Meta's Terms and Commerce Policies

- Meta's Terms prohibit accessing its products "using automated means" without permission. Lot Current opens the create-listing page in the user's own browser, fills in the form fields and attaches photos; the user reviews and clicks Publish. It never clicks Publish, Update, Delete or Mark as sold, uses no delays, spoofing, proxies or extra accounts, and never handles Facebook credentials. Is form pre-fill with a person publishing an acceptable position under the Terms as written? How does it compare with existing dealer posting tools that auto-post?
- What is the exposure for Lot Current (the company) and for the salespeople (personal accounts) if Meta disagrees, and how should the Terms, the Posting Rules and the marketing wording describe that risk honestly?
- Commerce Policies: Marketplace does not allow dealers to list new vehicles and requires vehicle listings to be accurate. Anything else in the vehicle-listing rules we should enforce in the software (e.g. what "condition" and "title status" must mean)?
- Marketing wording: may we say "a person publishes every post" and "no bots" as a differentiator? Anything to avoid?

## 2. The founder's employment at the pilot dealer

- The founder is employed in sales at Ron Lewis CDJR Waynesburg and wants to sell Lot Current to that store, its sister stores and, later, competitors. Please review the employment agreement and handbook for moonlighting, conflict-of-interest, IP assignment ("work made for hire" or invention-assignment clauses that could reach software written on personal time), confidentiality, and any non-compete or non-solicit.
- Who owns the Lot Current IP today, and what should the founder do (written acknowledgement from the employer? entity formation before further work?) to keep it clean.
- Selling to the employer: any disclosure, approval or arm's-length requirements; using the employer's website data for a personal product before a signed agreement.

## 3. Reading dealer websites' inventory search

- Lot Current reads the same inventory search service the dealer's website uses (Cars Commerce, behind Dealer Inspire sites), from the dealer's own tab, with the dealer's written authorisation (Dealer Subscription Agreement section 2). Please review the Dealer Inspire / Cars Commerce website terms and any API terms for restrictions on this, and advise what the dealer's authorisation needs to say.
- Is it enough that the dealer authorises it, given the data is the dealer's own inventory published on its own site? What changes when we move to official inventory feeds later?

## 4. Advertising law for Marketplace posts

- Federal (FTC Act Section 5, and the FTC's used-car and advertising guidance) and Pennsylvania rules (Automotive Industry Trade Practices, 37 Pa. Code Chapter 301) for price display, documentation-fee disclosure and dealer identification in a Marketplace post. The dealership's website headline price includes a $490 doc fee; the software posts that price with a note "Price includes the $490 doc fee; tax and tags extra." Is that wording right, and what must appear in every listing (dealer name? licence number? "dealer" designation?).
- Lot Current will sell to dealers in other states; the doc fee and its wording vary by dealer and state, and the software only suggests a price note from the website's own prices. Which states require dealer or documentation fees inside the advertised price, and what should the price note say there?
- Who is liable if a salesperson posts a wrong price or fee statement: the dealer, the salesperson, the software provider? How should the Dealer Subscription Agreement allocate it?
- The dealership sets a default title status ("Clean") and condition ("Very good") that the software fills in on every listing unless the website's own text mentions a branded title; the salesperson can change it on the form before publishing. Is a dealer-wide default acceptable, and what process should back it (a title check per car, a written dealer policy, a record of who published)?

## 5. AI-written descriptions

- Descriptions can be drafted by an AI model through Anthropic's API from the dealer's own data, then checked by software rules and reviewed by the salesperson before publishing. What is Lot Current's liability if a published description is inaccurate, and what disclaimer, review requirement or record-keeping reduces it? Any disclosure obligation about AI-generated ad copy?

## 6. Company matters

- Trademark clearance for "Lot Current" (see trademark-note.md), and whether to file an intent-to-use application. The product was first called "Lot Sync" and was renamed on 2026-10-01 because LotSync LLC already sells dealership software under that name; is anything owed or at risk from the weeks the old name was used in drafts and a public code repository?
- Entity formation (LLC in Pennsylvania?) and timing relative to the pilot and IP questions above.
- Insurance: technology errors and omissions and cyber liability; what limits are sensible for a pilot-stage product.
- Pennsylvania sales tax on software subscriptions (canned software / SaaS treatment) and what to collect from dealers.

## 7. Employees posting from personal accounts

- Dealers will ask salespeople to post from personal Facebook accounts (Meta no longer allows dealer Pages to list vehicles). Any employment-law, wage-and-hour or privacy concerns with that, and what should the dealer's policy and the Posting Rules say? Does the dealer need a written policy on what happens to listings when a salesperson leaves?

- `forget_person` (the owner's tool for one person's deletion request) keeps a departed salesperson's listing link on listings still marked up (the dealership needs it to see the car come down) and keeps the Stripe webhook events, which carry a billing email; confirm both fit the deletion right in the privacy policy.

## 8. Privacy: what the data inventory could not settle

`docs/data-inventory.md` lists everything the product stores or sends, read from the code. The Privacy Policy, the Chrome Web Store answers and the store listing now follow it. Where the right wording is a legal judgment, the text carries "[Pending attorney answer: questions-for-attorney.md 8.N]" and waits for the answer to that item.

- **8.1** Chrome Web Store, "Authentication information". The extension never touches Facebook credentials. For Lot Current's own account, the person types a six-digit sign-in code, which goes to our database host to be checked and is not kept, and the extension then keeps the session's access and refresh tokens in its own browser storage. For a self-hosted description writer, it keeps a key the person types in Settings. Should this box be ticked?
- **8.2** Chrome Web Store, "Location". The extension reads no device location. The dealership's city, state and ZIP (from its website or typed in Settings) go into each listing. When the person is signed in, every request to our database host carries their IP address, which the host's logs and its sign-in log keep. The problem report the person copies into an email to support includes their time zone. Should this box be ticked?
- **8.3** Chrome Web Store, "Web history". The extension keeps the dealership website's address and, for each car posted, the address of its Marketplace listing, and while a post is open it reads the Marketplace tab's address to see when the listing is published. It keeps no list of the pages the person visits. Should this box be ticked?
- **8.4** Chrome Web Store, "User activity". The Numbers tab records when each post started, reached review, opened and filled the form, and ended, with its outcome; which form fields could not be filled; and when to-do items were flagged and fixed. When the person is signed in, the post attempts and to-do items go to the dealership's database, where its managers see them. No clicks, keystrokes, mouse movement or scrolling are recorded. Should this box be ticked?
- **8.5** Retention periods we set ourselves. Today the code deletes these only on request, or never: demo requests from the website; the support inbox and log; the copy of each Stripe webhook event, which is kept after its dealership is deleted as the accounting record and can carry the billing contact's email, name, address and phone; the account of a person removed from a dealership that carries on, kept until they ask; and each account's self-serve sign-up attempts, kept for the life of the account because they count toward the one-dealership-per-account limit. What period should the policy state for each, and should the code delete on that schedule?
- **8.6** Copies kept on other companies' schedules. After we delete a row, copies remain for times we do not set: our database host's backups, and its request, sign-in and function logs (IP addresses and browsers among them; the description writer's log lines carry each car's year, make and model); Stripe's records after a customer is deleted; the web host's access logs; the logs of the service that serves the manager view's database library; and whatever Anthropic's terms let it keep of a request. How should the policy's "deleted within 30 days" and its Retention section account for these, and must it state each period?
- **8.7** Sale and sharing. We receive nothing for data and do no advertising. Do any of the disclosures to the processors the policy names count as a "sale" or "sharing" under the state laws that apply, and which contract terms (data processing agreements) must be in place with each for "We do not sell personal data" to stand?
- **8.8** Who counts as a processor. The synced profile lives in Chrome's sync storage under the person's own Google account, under Google's terms and the person's own Chrome settings. The manager view downloads its database library from jsDelivr, which then sees the manager's IP address and browser (serving that file from our own host would remove jsDelivr). Should the policy list Google and jsDelivr as processors, as other recipients, or not at all?
- **8.9** A salesperson's name sent to an AI provider. With the description writer on, each request carries the salesperson's name and role (for the sign-off) with the car's facts to Anthropic. Is the policy's disclosure enough, or must the dealership, as employer, or Lot Current tell salespeople, or get their agreement, first?

## After review

Once the attorney approves the Terms and Privacy Policy, the first-run wizard will require acceptance of both (Milestone 5 in PLAN.md).
