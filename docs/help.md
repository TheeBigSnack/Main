# Lot Sync help

For salespeople and managers. It is organised by what you are trying to do. Every button and tab is named the way the popup and the side panel show it. "The popup" is what opens when you click the Lot Sync icon in Chrome's toolbar. "The side panel" is the panel Chrome opens at the side of the window when you post a car, set up Lot Sync or fix a listing.

Two things to know before anything else:

- **You click Publish. Lot Sync never does.** It fills in the Marketplace form and opens pages. It never clicks Publish, Update, Delete or Mark as sold, and it never posts or edits while you are away.
- **Lot Sync is not affiliated with Meta Platforms, Inc.** "Facebook" and "Marketplace" are used here only as the names of the places you post.

Something not covered here? See `docs/support.md` for how to reach support and what to send.

## Install and update

### Install (about two minutes)

1. Your manager sends you `lot-sync-extension-<version>.zip`. Unzip it into a new folder that will stay put, for example `Documents\Lot Sync`. The zip holds the extension's files themselves (`manifest.json` and the rest), not a folder.
2. In Chrome (version 116 or newer) go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Lot Sync**.

Chrome says the extension can read and change data on `www.facebook.com/marketplace` and on the dealer photo host. That is what filling the form and attaching the car's photos needs. It does not read your Facebook password, cookies or messages.

### Update

When a new zip arrives, unzip it into the same folder, replacing the files. Then open `chrome://extensions` and click the reload icon on Lot Sync. Your scans, settings and posted list are kept: they live in Chrome's storage, not in the folder. A new folder would leave Chrome on the old files.

### Which version do I have?

Click the Lot Sync icon, then **Settings**. The first line reads "Lot Sync <version> · form map <date>". `chrome://extensions` shows the version under the name too. Support asks for this line in every report.

## Set up (the first time on a website)

1. Open your dealership website's used inventory page.
2. Click the Lot Sync icon. The **To do** tab shows "First time here?" with a **Set up Lot Sync** button. Click it. The side panel opens.
3. Walk the steps. Keep the inventory page open in this window while you do.
   - **Start**.
   - **Read the website**: Lot Sync reads the used inventory and says how many cars and stores it found.
   - **Your store**: tick your store. Only cars at ticked stores count as ready to post.
   - **You**: your name and your role. Every description ends with "I'm [name], [role] at [dealership]". Posing as a private seller is not allowed.
   - **Your account** (only once accounts are set up; while **Settings**, **Account** says "Accounts are not set up yet", this step is not shown): type your work email, click **Send me a sign-in code**, enter the six-digit code from the email and click **Sign in**. There is no password. Then enter the invite code your manager gave you and click **Join**; the step says which dealership you joined and your role. A wrong, used or expired code shows "that invite code is not valid": check it and click **Join** again, or ask your manager for a new code. The step is optional: **Skip for now** goes on without signing in, **Next** goes on without joining, and **Settings**, **Account** does both later. When you are signed in, **Finish set-up** also starts the first sync with your dealership's account; **Settings**, **Account** shows how it went.
   - **The store's address**: read from the website. Check the dealership name, city, state and ZIP. Marketplace asks for a location, and the ZIP is what gets typed.
   - **The price to post**: the website's main price. When the website shows a lower second price under its cars, you can choose that instead; some states require the advertised price to include dealer fees, so check with your manager first. On a website with one price per car there is nothing to choose. Below it, the price note that goes in every description: it is empty until you type it, and when the two prices differ by the same amount on most cars Lot Sync suggests wording ("Suggested: ...") that only your store can confirm. The listed price always equals the website price; the note says what it includes.
   - **Automatic rescans**: click **Allow automatic rescans** and Chrome asks for permission to read the website in the background. Or click **Skip for now**; the **Scan website** button still works by hand. The tick "Show a desktop notification when listings need attention" is yours to set.
   - **The posting rules**: read them and tick "I have read the posting rules and will follow them".
   - **Terms and privacy**: a short summary of what Lot Sync reads and keeps. While the Terms of Service and the Privacy Policy are being finalised (they are today) the step says so, shows no links or tick, and records nothing. Once they are published, the step shows links to both documents and the tick "I have read and accept the Terms of Service and the Privacy Policy", which you must tick before you can finish; Settings has the same tick. Click **Finish set-up**. Lot Sync reads the website once more with your final settings.
   - **Close**. The popup's **Ready to post** tab is where to go next.
4. **Quit set-up** stops at any step. The popup then offers **Continue set-up**. **Not now** on the banner skips set-up altogether; **Settings** has the same fields.

## Scan

- **Scan website** is the button at the top right of the popup. Once a scan is saved it reads **Rescan website**. It only works when the tab is on your dealership's website; on any other page the popup says "Open your dealership's website, then scan."
- The first scan saves a starting point. From then on each scan compares with the last one, and the **To do** tab lists what sold, what changed price and what is new.
- The tabs, left to right: **To do**, **Ready to post**, **Not ready**, **Other stores** (only on a group website with cars at other rooftops), **Needs a look**, **My listings**, **Numbers**. Each shows a count.
- **Ready to post**: pre-owned, at your store, with photos and a price.
- **Not ready**: pre-owned cars at your store that are missing something a listing needs. They move to Ready to post on their own once the website has it.
- **Other stores**: your group's cars at other rooftops, kept off your list. Change your store in Settings.
- **Needs a look**: the website's details for the car do not add up (a used car showing 0 miles, signs that disagree). Fix them on the website, or ask whoever manages inventory, then scan again. Below it, "Skipped as new (never posted)" lists cars the website calls new, demo or loaner. They can never be posted with Lot Sync.
- With automatic rescans on, Lot Sync re-reads the website every 3 hours while Chrome is open and puts your to-do count on its icon. It only reads the website then; it never touches Facebook on its own.

## Post one car

1. On **Ready to post**, click **Post** next to the car. The side panel opens. If Chrome did not open it, the popup says so: open it from Chrome's menu (Side panel).
2. The panel re-checks the car on the website: still pre-owned, still on the lot, still priced. If something fails, a red message says why, with a **Back** button.
3. The review screen:
   - **Description**: written from the website's facts, signed with your name and role, with the VIN. Edit anything you like. **Reset to template** brings the built-in draft back. **Copy** copies it. **Rewrite with Claude** works only when the description writer is on (see below).
   - The checks line: "All checks passed" or "Fix before posting" with the reasons. Every number must be on the website, no banned phrases, the dealership must be named.
   - **What Lot Sync will fill in**: each form field and the value, including Photos.
   - **VIN check**: the VIN against what the website says. **Check with NHTSA (free government decoder)** fetches the government decode and lists every difference. It changes nothing by itself.
   - **Filled from your dealership's defaults**: **Vehicle condition** and **Title status**. **You fill in yourself** lists what Lot Sync leaves blank, for example the title of a car whose website text mentions rebuilt, salvage or a lien.
4. The line "N of M posts today" is the daily cap. Click **Open the Marketplace form**. A new tab opens on Facebook's create-vehicle-listing page. Sign in if Facebook asks; Lot Sync never sees that. The fields fill in and the photos attach.
5. Back in the panel: **Filled in** lists each field as the form shows it, read back after filling. **Needs a click** lists a value that is in but wants a click on the form to confirm. **Couldn't fill** lists anything it could not do, with a **Copy** button per value. Under **Photos**: **Download photos**, **Fill again** and **Copy description**.
6. On Facebook, check every field, including **Vehicle condition** and **Title status**. Then click **Publish** yourself.
7. The panel notices the listing page and shows "Looks like it posted". Click **It's posted, record it**. If it did not notice, paste the listing's address into **Listing link (optional)** first. If you closed the tab without publishing, click **It didn't post**; nothing is recorded.
8. The car now shows under **My listings**, and every rescan watches it. Click **Post another car** to go on.

Already listed a car by hand? Click **Mark posted** next to it on Ready to post, so rescans watch that listing too. A posted car shows **Posted ✓**; clicking that unmarks it.

First run on a new machine: on the review screen, **Open the form and check fields only (nothing filled)** opens the form and only reports which fields Lot Sync can find. From there: **Fill it in now**, **Check again**, **Copy report** or **Back**.

## Post several (the queue)

- On **Ready to post**, tick the cars you want, or tick **Select the next N** to take the first N from the top. The button reads **Post selected** until you tick, then **Post N cars**. Click it.
- On **To do**, **Queue all N ready arrivals** queues the new arrivals that are ready.
- The side panel takes the cars one at a time. A car that passes every check opens and fills the Marketplace form straight away. A car with a warning stops at the review screen so you see it.
- For each car: check the form and click **Publish** on Facebook. The panel notices the listing and loads the next car. If it did not notice, click **It's posted, next car**. Prefer drafts? Click Facebook's **Save draft**, then **Saved as draft, next car**. **Skip, next car** moves on without posting. A car the re-check blocks offers **Skip this car, next**.
- The queue bar at the top of the panel: **Post next car**, **Pause**, **Resume**, **Skip this car**, **Stop queue**, and **Clear queue** when it is finished. In the popup, the Ready to post tab shows the same queue with **Continue in the side panel**, **Stop the queue** and **Clear**.
- The queue survives closing the panel. It can never be longer than the day's remaining cap, and it pauses when the cap is reached. Posted cars stay recorded when a queue is stopped.
- A car saved as a draft shows "Draft on Facebook" on Ready to post until you publish it on Facebook and click **Mark posted**.

## When a car sells or a price changes

Only cars marked as posted are watched: cars posted through the panel or marked with **Mark posted**. A to-do item for a car you did not mark shows greyed out with "not marked as posted" and no button.

**A sold car.** The **To do** tab lists it under **Take down**, with the reason (sold, or gone sale-pending).

1. Click **Open listing**. The side panel opens your listing in a new tab.
2. On Facebook, click **Mark as sold** (or **Delete**) yourself. The panel notices ("The listing shows it as sold or removed") and ticks the item off.
3. If it does not notice, click **I took it down** in the panel. **Not now** leaves the item for later.
4. Took it down some other way? **Taken down** in the popup ticks the item off by hand.

**A price change.** The **To do** tab lists it under **Update price**, with the old price, the new price and the difference.

1. Click **Open & update price**. The panel opens your listing.
2. On Facebook, click **Edit listing**. The moment the Price box appears on this car's form, Lot Sync puts the website's new price in it and the panel tells you what the box shows.
3. Click **Update** yourself. The panel notices the new price on the listing and ticks the item off. If not, click **I updated it**.
4. Updated it some other way? **Updated** in the popup ticks it off by hand.

Notes:
- If no listing link was saved for the car, the panel opens Marketplace's Your listings page instead and asks you to open the listing there.
- The panel only fills or ticks off when the tab is showing that car's listing. If you moved to another page it says "This tab isn't showing the listing for [car]".
- A post that is under way blocks a to-do item: finish or stop it first, then click the To do button again.
- **My listings** shows each car as "Matches the website", "Website price changed" (with **Updated**) or "Not on the website at the last scan", with **Taken down** and, when a link was saved, **Open listing**.
- The posting rules ask for sold cars to come down the same day.

## The Numbers tab

**Numbers** shows the numbers the pilot agreement lets Lot Sync record, kept in this browser, per website:

- how long each post took, from the click on **Post** to **It's posted, record it**, your review included;
- which form fields Lot Sync could not fill, by field name only;
- how long sold cars and price changes stayed on your listings, from the scan that flagged them to the moment the change was seen or you ticked the item off.

It never records buyers, messages, the description text or anything from your Facebook account beyond your own listings.

- **Download CSV** saves the spreadsheet to your Downloads folder; that is what your manager collects.
- **Copy summary** copies a short text for the weekly check-in.
- **Clear the numbers** needs two clicks (the button changes to "Click again to clear the numbers").
- The numbers also prune themselves each time one is recorded: each list (post attempts, form fills, to-do items) keeps its newest 500 entries and nothing older than 90 days. An open to-do item stays until it is closed. Download the CSV before then if your manager wants the full record.

## Settings

Click **Settings** at the top of the popup. Click **Save settings** at the bottom, then **Rescan website** to apply. The sections:

- **You**: your name and your role, for the sign-off in every description.
- **Your store**: tick your store or stores. Leave all unticked to include every store.
- **Dealership, named on every listing**: dealership name, city, state, ZIP. The scan fills these from the website; what you type wins. Marketplace suggests every town with the same name, and Lot Sync only accepts the one in your state, so keep the state and ZIP filled.
- **Price to post**: the website's main price, or the lower second price the website shows (only offered when the website shows one; ask your manager first). **Price note in every description** explains what the price includes. Lot Sync suggests wording from the website's price gap but never fills it in for you.
- **Listing defaults**: **Title status** and **Vehicle condition**, filled in on every listing. "Leave blank" answers them per car on the form.
- **Safety**: **Posts per day, per salesperson**. See the daily cap below.
- **Automatic rescans**: the rescan tick, the desktop notification tick, and **Allow automatic rescans** when the permission has not been granted yet.
- **Description writer (optional)**: off by default. See below.
- **Terms and privacy**: today, a note that the Terms of Service and the Privacy Policy are being finalised and can be read and accepted here once they are published. From then on: links to both documents, the date and edition you accepted, and the tick "I have read and accept the Terms of Service and the Privacy Policy" until you have accepted the current edition.
- **Saved data**: **Clear everything for this website** and **Forget my synced profile**. See "Where the data lives" below.

Your profile follows you. Your name, role and listing defaults follow you to any dealership website. The dealership part (name, address, stores, price basis, price note and daily cap) belongs to that dealership's website and does not travel to another site. Both are kept in Chrome's synced storage under your own Google account, so they come back after clearing a website's data or reloading the extension.

## When a field could not be filled

The panel lists it under **Couldn't fill**, with the value Lot Sync wanted to enter, the reason (what the form showed), and similar controls it saw on the page.

1. **Copy the report.** On that screen, the list itself is the report. For a fuller one, go back to the review screen and click **Open the form and check fields only (nothing filled)**, then **Copy report** on the result. Then click **Copy problem report** under **Report a problem** in **Settings**: it copies the version, the website, the last scan and the last fill's field names (no names, cars or links) for the same message.
2. **Send it** to support (`docs/support.md` says where and what else to include). Each fix is one line in the form map and comes back in the next zip.
3. **Fill it by hand.** Click **Copy** next to the value, paste it into the field on Facebook, and check the field before you publish. **Needs a click** means the value is in but the form wants a click to confirm it; click it.

Photos that would not attach: click **Download photos**, then add them from your Downloads folder on the form. If Facebook is set to another language, the panel says so: switch Facebook to English (Facebook's Settings, Language), then click **Fill again**.

## When Facebook restored a draft

Facebook sometimes opens the create-listing page with a saved draft or an unfinished listing already in it, often another car, and sometimes it restores that draft a few seconds after the page opens. Lot Sync notices and puts a red banner in the panel:

- "This form already held another vehicle before Lot Sync filled it": Lot Sync replaced every field it manages, but photos and anything else from that draft may still be on the form.
- "Facebook changed [field] a few seconds after Lot Sync filled it": Lot Sync set the fields again and says whether they held.

What to do:

1. Check every field in the **Filled in** list against the form.
2. Remove the other car's photos from the form, or discard the draft on Facebook and click **Fill again**.
3. Delete that draft on Facebook so it stops coming back: Marketplace, Your listings, Drafts.
4. Only then click **Publish**.

Before a first day of posting, delete any old Marketplace drafts.

## When Chrome asks for a permission

Chrome only asks because you clicked something in Lot Sync. Three cases:

- **Allow automatic rescans** (in set-up, on the To do tab or in Settings): permission to read your dealership's website and its inventory service in the background, for the 3-hourly rescans. Allow it, or decline and scan by hand; the popup then says "Not allowed, so automatic rescans stay off."
- **Check with NHTSA (free government decoder)** in the side panel: permission to reach `vpic.nhtsa.dot.gov` for the VIN decode. Decline and the VIN is simply not checked online.
- At install, Chrome shows what the extension can read: `www.facebook.com/marketplace` and the dealer photo host.

Lot Sync never asks for your Facebook password, cookies or tokens, in Chrome's prompts or anywhere else.

## When the website scan fails

- "Can't read this page": the tab is not on your dealership's website. Open the used inventory page and click **Scan website** again.
- The website is not one Lot Sync can read yet. Today it reads Dealer Inspire websites that use the Cars Commerce inventory search. Other platforms are being added one at a time; tell support which website yours is.
- "Couldn't reach the dealership tab" during set-up: open the used inventory page, click the Lot Sync icon and click **Continue set-up**.
- A warning that many cars vanished at once: if more than half the lot disappears between scans, nothing is marked gone and the last good scan is kept. Scan again later; if it repeats, tell support.
- "Automatic rescans are on, but Lot Sync has no permission to read this website in the background": click **Allow automatic rescans** on the banner.
- "The last automatic rescan failed": the website could not be read at that moment. A scan by hand still works; if it keeps failing, send the message to support.

## When the description writer is off

The description writer is off by default, and Lot Sync works without it. Descriptions then come from the built-in template: the website's facts, 60 to 120 words, your sign-off and the VIN. **Rewrite with Claude** and **Guess from the photos** in the side panel are greyed out with the note "Turn on the rewrite service in Settings first".

To turn it on, your dealership needs the Lot Sync rewrite service running and its address and key from whoever runs it. In **Settings**, **Description writer (optional)**: tick "Use the Lot Sync rewrite service (Claude) for first drafts", enter **Service address** and **Service key**, and save. Either way, every draft goes through the same checks, and you review it before you post. If the service is unreachable or a draft fails a check, the template is used and the panel says so.

## The daily cap

Each salesperson may record a set number of posts a day, 10 by default. Your dealership changes it in **Settings**, **Safety**, **Posts per day, per salesperson**.

- The review screen shows "N of M posts today". At the cap, **Post** buttons and tick boxes go away on Ready to post, **Open the Marketplace form** is disabled, and a queue pauses. The message reads "Daily post cap reached (N of M today). It resets tomorrow; the dealer can change it in Settings."
- It counts posts recorded in this browser for this website today.
- It is a safety setting, not a guarantee of anything from Facebook. Meta does not publish its limits.

## The manager view (for managers)

A web page your Lot Sync contact gives you the address of. It shows your whole dealership once your salespeople sign in to their extensions (Settings, Account).

- **Sign in**: type your work email and click **Send me a sign-in link**. Open the link in the same browser on the same computer; it will not work in another browser. There is no password.
- **Start your dealership** (only once Lot Sync's owner has opened sign-up; until then your Lot Sync contact sets the dealership up and sends you an invite code): when you are signed in and your account is in no dealership yet, the page shows **Start your dealership**. Type the **Dealership name**, the **Website address** and **Your name**, then click **Start the dealership**. Under the address the page shows the website Lot Sync will keep: it must match the address bar on the dealership's inventory pages, www included, because that is the website the extension syncs. You become the dealership's manager and the page opens on it. If it can't be started, the page says why (for example, sign-up is not open, or that website already has a dealership) and keeps what you typed. If your store already uses Lot Sync, don't start another one: ask its manager for an invite code and enter it in the extension under **Settings**, **Account**. Once your dealership is started, sign in to the extension with the same email (**Settings**, **Account**, or the set-up's **Your account** step). You are already in the dealership, so there is no invite code to enter: at the set-up step, click **Next**.
- **Getting started** (managers, above the other cards): four steps, each marked Done or To do with one sentence. **Start the free pilot or subscribe**; **Invite your salespeople** (an open invite code, or a second person in the dealership); **First car posted and synced** (any car a signed-in salesperson posted); **Two salespeople posting** (two different salespeople posted in the past 7 days; a manager's own posts don't count). **Go to Billing** and **Go to Invite codes** take you to the card that does the step. Once all four are done, the card shrinks to one line.
- **Billing**: where the dealership's plan stands (no plan yet, free pilot with the days left, subscribed, or lapsed) and, for managers, **Start the free pilot**, **Subscribe** and **Manage billing** (Stripe's own pages, for the card and the invoices). When the plan has lapsed, salespeople can still post by hand, but nothing syncs and the description writer is off until it is renewed.
- **Invite codes**: **Invite a salesperson** or **Invite a manager** makes a code that works once and for 7 days; **Copy** puts it on the clipboard. The card lists every open code with the day it expires; **Revoke** cancels one that went to the wrong person. A code stops working when the manager who made it leaves the dealership or stops being a manager.
- **Team**: everyone in the dealership's account. **Make manager** and **Make salesperson** change a role; **Remove** takes two clicks and stops that person's extension from syncing (the cars they posted stay in the numbers). A dealership always keeps at least one manager, so make someone else a manager before you step down or leave.
- **Salespeople**, **Sold cars still listed** and **Price changes not yet updated**: the same numbers the salespeople's Numbers tabs keep, for the whole store, with **Download CSV** for the spreadsheet.

## What Lot Sync never does

- Click Publish, Update, Delete or Mark as sold. Ever. There is no code for it, and a test that fails if any appears.
- Post or edit in the background or while you are away. Automatic rescans only read your dealership's website.
- Post new, demo or loaner cars, or anything the pre-owned check cannot confirm.
- Invent prices or price drops. The listed price is the website price, and price changes only mirror the website.
- Make claims the website's data does not support, or hide that the car is at a dealership.
- Ask for, read or store your Facebook password, cookies or tokens; use fake delays, proxies or spoofing; or run more than your one account.
- Claim any affiliation with Meta. Lot Sync is not affiliated with Meta Platforms, Inc.

Meta's Terms prohibit accessing its products "using automated means" without permission. Having a person click Publish is the safest design available, but it is not a guarantee. If Facebook ever warns you about your listings, stop and tell your manager.

## Where the data lives and how to clear it

**In this browser, per website:** the last scan, the to-do list, your posted list, your settings for that website (including the rewrite service key, which stays on this computer), the queue, drafts, set-up progress, a post under way, and the numbers on the Numbers tab (which prune themselves: each list keeps its newest 500 entries and nothing older than 90 days, open to-do items excepted). Each website's data is separate. Nothing leaves this browser unless you sign in under Settings, Account: then your posted list, your post timings and your to-do items sync to your dealership's account for the manager view, and nothing else does.

**In Chrome's synced storage, under your own Google account:** your profile (name, role, dealership, price basis, note, cap, listing defaults, Terms acceptance). It follows you to other computers where you are signed in to Chrome.

**What leaves the browser, and only when you act:** reads of your dealership's website and its inventory service (each scan, and the rescans you allowed); the car's photos from the dealer's image host (when a form is filled or **Download photos** is clicked); the NHTSA decode (when you click **Check with NHTSA (free government decoder)**); and, with the description writer on, the car's facts, the dealership name and city, your name and role, the price note, and the photo addresses for a colour guess, sent to the rewrite service. Nothing from your Facebook account is sent anywhere.

**To clear it:**

- **Settings**, **Saved data**, **Clear everything for this website**. Click twice; the button changes to "Click again to clear everything". This removes everything above for this website, takes the website off the automatic rescan list and its count off the icon. The synced profile stays.
- **Numbers**, **Clear the numbers** (two clicks) clears only the numbers for this website.
- "Couldn't save: Chrome's storage for Lot Sync is full. Clear the numbers on the Numbers tab, or open an old dealership website and click Clear everything for this website in Settings." Chrome gives Lot Sync 10 MB for every website together, and each website's scans, drafts and numbers count toward it. First click **Clear the numbers** on the **Numbers** tab (download the CSV first if your manager still needs it). If that is not enough, open a dealership website you no longer post from, click the Lot Sync icon, then **Settings**, **Saved data**, **Clear everything for this website**. Then do again what you were doing when the message appeared.
- Removing the extension at `chrome://extensions` removes what it kept on this computer.

## How to forget the synced profile

**Settings**, **Saved data**, **Forget my synced profile**. It removes the profile from Chrome's sync storage. The settings on this computer stay as they are; saving them again re-creates the profile. Clearing your Chrome sync data removes it too. Do this before removing the extension if you want nothing left behind.
