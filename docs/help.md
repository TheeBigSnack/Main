# Lot Current help

For salespeople and managers. It is organised by what you are trying to do. Every button and tab is named the way the popup and the side panel show it. "The popup" is what opens when you click the Lot Current icon in Chrome's toolbar. "The side panel" is the panel Chrome opens at the side of the window when you post a car, set up Lot Current or fix a listing.

Two things to know before anything else:

- **You click Publish. Lot Current never does.** It fills in the Marketplace form and opens pages. It never clicks Publish, Update, Delete or Mark as sold, and it never posts or edits while you are away.
- **Lot Current is not affiliated with Meta Platforms, Inc.** "Facebook" and "Marketplace" are used here only as the names of the places you post.

Something not covered here? See `docs/support.md` for how to reach support and what to send.

## Install and update

### Install (about two minutes)

1. Your manager sends you `lot-current-extension-<version>.zip`. Unzip it into a new folder that will stay put, for example `Documents\Lot Current`. Already installed from a folder with the old name? Keep using that folder: Chrome ties the extension's saved data to its folder, so renaming or moving it starts over empty. The zip holds the extension's files themselves (`manifest.json` and the rest), not a folder.
2. In Chrome (version 116 or newer) go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Lot Current**.

Chrome says the extension can read and change data on `www.facebook.com/marketplace` and on `vehicle-images.carscommerce.inc`, the Cars Commerce photo server used by the Dealer Inspire websites checked so far. That is what filling the form and attaching the car's photos needs; a website that keeps its photos on another server gets Chrome's own prompt for that server the first time you fill a form or download photos for one of its cars ("When Chrome asks for a permission", below). It does not read your Facebook password, cookies or messages.

### Update

When a new zip arrives, unzip it into the same folder, replacing the files. Then open `chrome://extensions` and click the reload icon on Lot Current. Your scans, settings and posted list are kept: they live in Chrome's storage, not in the folder. A new folder would leave Chrome on the old files.

### Which version do I have?

Click the Lot Current icon, then **Settings**. The first line reads "Lot Current <version> · form map <date>". `chrome://extensions` shows the version under the name too. Support asks for this line in every report.

## Set up (the first time on a website)

1. Open your dealership website's used inventory page.
2. Click the Lot Current icon. The **To do** tab shows "First time here?" with a **Set up Lot Current** button. Click it. The side panel opens.
3. Walk the steps. Keep the inventory page open in this window while you do.
   - **Start**.
   - **Read the website**: Lot Current reads the used inventory and says how many cars and stores it found.
   - **Your store**: tick your store. Only cars at ticked stores count as ready to post.
   - **You**: your name and your role. Every description ends with "I'm [name], [role] at [dealership]". Posing as a private seller is not allowed.
   - **Your account** (only once accounts are set up; while **Settings**, **Account** says "Accounts are not set up yet", this step is not shown): type your work email, click **Send me a sign-in code**, enter the six-digit code from the email and click **Sign in**. There is no password. Then enter the invite code your manager gave you and click **Join**; the step says which dealership you joined and your role. A wrong, used or expired code shows "that invite code is not valid": check it and click **Join** again, or ask your manager for a new code. If you already belong to that dealership, a code does nothing and says so ("you are already a salesperson of this dealership; the code was not used"), and the code still works for the person it was made for. The step is optional: **Skip for now** goes on without signing in, **Next** goes on without joining, and **Settings**, **Account** does both later. When you are signed in, **Finish set-up** also starts the first sync with your dealership's account; **Settings**, **Account** shows how it went.
   - **The store's address**: read from the website. Check the dealership name, city, state and ZIP. Marketplace asks for a location, and the ZIP is what gets typed.
   - **The price to post**: the website's main price. When the website shows a lower second price under its cars, you can choose that instead; some states require the advertised price to include dealer fees, so check with your manager first. On a website with one price per car there is nothing to choose. Below it, the price note that goes in every description: it is empty until you type it, and when the two prices differ by the same amount on most cars Lot Current suggests wording ("Suggested: ...") that only your store can confirm. The listed price always equals the website price; the note says what it includes.
   - **Automatic rescans**: click **Allow automatic rescans** and Chrome asks for permission to read the website in the background. Or click **Skip for now**; the **Scan website** button still works by hand. The tick "Show a desktop notification when listings need attention" is yours to set.
   - **The posting rules**: read them and tick "I have read the posting rules and will follow them".
   - **Terms and privacy**: a short summary of what Lot Current reads and keeps and, in a copy with accounts, what syncs to your dealership's account while you are signed in. While the Terms of Service and the Privacy Policy are being finalised (they are today) the step says so, shows no links or tick, and records no acceptance; the usage numbers it summarises are recorded from your first post either way. Once they are published, the step shows links to both documents and the tick "I have read and accept the Terms of Service and the Privacy Policy", which you must tick before you can finish; Settings has the same tick. Click **Finish set-up**. Lot Current reads the website once more with your final settings.
   - **Close**. The popup's **Ready to post** tab is where to go next.
4. **Quit set-up** stops at any step. The popup then offers **Continue set-up**. **Not now** on the banner skips set-up altogether; **Settings** has the same fields, the posting rules included. Until the posting rules are ticked for a website (in set-up, in **Settings** or in the side panel), the side panel shows them before your first post there, with the same tick, and posts nothing until you tick it.

## Scan

- **Scan website** is the button at the top right of the popup. Once a scan is saved it reads **Rescan website**. It only works when the tab is on your dealership's website; on any other page the popup says "Open your dealership's website, then scan."
- The first scan saves a starting point. From then on each scan compares with the last one, and the **To do** tab lists what sold, what changed price and what is new. **New arrivals** on To do stays for the window: every car that came onto the lot within the last 7 days by the website's in-stock date, or that Lot Current first saw within the last 7 days when the website gives no date, that nobody has posted, plus whatever the last scan found that was not on the website the time before, newest first, each with its date line. A car you post drops off it. Nothing is new by first sighting on the first scan: those cars were already there.
- The tabs, left to right: **To do**, **Ready to post**, **Not ready**, **Other stores** (only on a group website with cars at other rooftops), **Needs a look**, **My listings**, **Numbers**. Each one except **Numbers** shows a count.
- **Ready to post**: pre-owned, at your store, with photos and a price. The list is newest on the lot first; the **Sort** menu also offers longest on the lot, price low to high, and name, and the choice is remembered for this website. The search box narrows the list as you type: a stock number, the last six characters of a VIN, or words of the year, make or model (every word you type must match); Escape clears it, and "No cars match" means nothing on the list fits. A car that came onto the lot within the last 7 days by the website's in-stock date, or that Lot Current first saw within the last 7 days when the website gives no date, carries a **New** pill (the number is in Settings), and under each car one small line says where its date comes from: "on the website since [date] · N days on the lot" when the website gives an in-stock date, or "Lot Current first saw it [date]" when only a scan can say, which never counts days on the lot (the car may have sat there long before). A car with neither reads "no date on the website, and Lot Current did not see it arrive". A car you have posted is never marked New.
- **Not ready**: pre-owned cars at your store that are missing something a listing needs. They move to Ready to post on their own once the website has it.
- **Other stores**: your group's cars at other rooftops, kept off your list. Change your store in Settings.
- **Needs a look**: the website's details for the car do not add up (a used car showing 0 miles, signs that disagree), or the website lists it as damaged or refurbished, or it is a trailer, RV, powersport vehicle or boat (Lot Current fills in only Marketplace's car/truck and motorcycle forms; the reason quotes the website's words). Fix them on the website, or ask whoever manages inventory, then scan again. Below it, "Skipped as new (never posted)" lists cars the website calls new, demo or loaner. They can never be posted with Lot Current.
- With automatic rescans on, Lot Current re-reads the website every 3 hours while Chrome is open and puts your to-do count on its icon. While you are signed in to a Lot Current account, it also sends that rescan's results (your posted list, post records, to-do items and the scan's counts) to your dealership's account. It never touches Facebook on its own.

## Post one car

1. On **Ready to post**, click **Post** next to the car. The side panel opens. If Chrome did not open it, the popup says so: open it from Chrome's menu (Side panel).
2. The first time you post from a website whose posting rules you have not ticked (set-up skipped), the panel shows them first: tick "I have read the posting rules and will follow them" and click **Continue to the post**; **Not now** posts nothing (and pauses a queue). Then the panel re-checks the car on the website: still pre-owned, still on the lot, still priced. If something fails, a red message says why, with a **Back** button.
3. The review screen:
   - **Description**: written from the website's facts, signed with your name and role, with the VIN. Edit anything you like. **Reset to template** brings the built-in draft back. **Copy** copies it. **Rewrite with Claude** works only when the description writer is on (see below).
   - The checks line: "All checks passed" or "Fix before posting" with the reasons. Every number must be on the website, no banned phrases, and the dealership and your role (your title from Settings) must be named. With no dealership name set in Settings, every description fails until it is.
   - **Highlights**: the website's own features for this car, with the ones the description names ticked (up to 6, numbered in the order they are named). Tick and untick, then click **Use these highlights** to write the description again with them. Only features the website lists can be picked. If you had edited the description, your edits are replaced.
   - **Photos**: every photo the website shows for the car, ticked when it goes on the listing and numbered in the order it is attached. The first is the cover, the one Marketplace shows first. Untick the ones you don't want, click **Make cover** under the photo to put first, **Use the website's order** to go back to the website's order, or **Untick all**. Only the ticked photos are attached (and downloaded by **Download photos**); with every photo unticked, **Open the Marketplace form** says to tick one first. The pick is for this car only.
   - **What Lot Current will fill in**: each form field and the value, including Photos.
   - **VIN check**: the VIN against what the website says. **Check with NHTSA (free government decoder)** fetches the government decode and lists every difference. It changes nothing by itself.
   - **Assumed: check these on the form**: every value Lot Current filled in without the website stating it in the form's own words, each with where it came from: **Vehicle condition** and **Title status** from your dealership's defaults; a colour guessed from the photos; and readings of the website's words, such as a mild hybrid listed as Hybrid ("the website says Gasoline/Mild Electric Hybrid"; change it on the form if you list mild hybrids as Gasoline), a body style read from the car's page address, a shade name such as Pewter read as Gray, an electric car's single-speed gearbox listed as Automatic, or a motorcycle read only from its make. **You fill in yourself** lists what Lot Current leaves blank, for example the title of a car whose website text mentions rebuilt, salvage or a lien.
   - A field whose website words match nothing on the form (natural gas or propane fuel; a body style such as "4dr Car" when the car's page address names no body style either) is left blank, and **What Lot Current will fill in** shows the website's own words next to it. Pick it on the form.
   - In a queue, a car with anything under **Assumed: check these on the form** besides **Vehicle condition** and **Title status** waits on this screen instead of opening the form by itself, so you see what was assumed first.
   - A car you took off your listings (**Taken down**, or unmarking **Posted ✓**) in the last 30 days while the website still listed it as ready opens with a notice at the top: "You took this car off your listings on [date], while the website still listed it." The posting rules forbid deleting and reposting to bump a listing; post it again only if the old listing is gone for another reason, such as Facebook removing it or a **Taken down** clicked by mistake. Lot Current does not stop the post, and in a queue the car waits on this screen so you see the notice.
4. The line "N of M posts today" is the daily cap. Click **Open the Marketplace form**. A new tab opens on Facebook's create-vehicle-listing page. Sign in if Facebook asks; Lot Current never sees that. The fields fill in and the photos attach.
   - The first time a car's photos sit on a server Lot Current may not download from yet, the review screen says "Chrome will ask to let Lot Current download this car's photos from [server]." When you click, Chrome's own prompt asks. Allow it once and Chrome remembers it for every car on that server. The form fills in either way.
5. Back in the panel: **Filled in** lists each field as the form shows it, read back after filling. **Needs a click** lists a value that is in but wants a click on the form to confirm. **Couldn't fill** lists anything it could not do, with a **Copy** button per value. Under **Photos**: **Download photos**, **Fill again** and **Copy description**.
   - If you said no to Chrome, **Photos** says which server was not allowed and that its photos are not attached, with an **Allow photos from [server]** button. It asks Chrome again; if you allow it, those photos attach to the open form. While the side panel stays open, Lot Current doesn't ask about that server again unless you click that button.
6. On Facebook, check every field, including **Vehicle condition** and **Title status**. Then click **Publish** yourself.
7. The panel notices the listing page and shows "Looks like it posted". Click **It's posted, record it**. If it did not notice, paste the listing's address into **Listing link (optional)** first. If you closed the tab without publishing, click **It didn't post**: nothing is posted or added to **My listings**, and the Numbers tab records the attempt as not posted (the car, your name and how long it was open) and counts it under "Started but not posted". While you are signed in, that record also syncs to your dealership's account with your other post timings, where you and your managers see it.
8. The car now shows under **My listings**, and every rescan watches it. Click **Post another car** to go on.

**Post the next car from the side panel.** You don't have to go back to the popup or keep the dealership website open. When the panel has nothing under way, it shows its own **Ready to post** list for the website it last worked on (a post, set-up or To do item there, or the **Website** menu below), or, before it has worked on any, the website you scanned most recently; scanning another website in the popup does not switch it: the same cars, order and **New** pills as the popup's tab, with a line saying when the last scan was, how many cars are ready and how many more posts the daily cap allows today. Click **Post** next to a car; the panel re-checks it on the website and goes on from step 3. **Sort** and the search box work as on the popup (Escape clears the search), **Rescan the website** reads the website again from here, and with more than one website set up on this computer a **Website** menu picks which one. A car saved as a Facebook draft shows "Draft on Facebook" instead of **Post**, and at the daily cap the **Post** buttons go away.
- The first time you post or rescan from the panel without the dealership website open in a tab, Chrome asks to let Lot Current read the website (see "When Chrome asks for a permission"). If you said no, the panel stops with **Allow reading [website]**, which asks again and re-checks the same car, or open the website's used inventory page and post from the popup there.

Already listed a car by hand? Click **Mark posted** next to it on Ready to post, so rescans watch that listing too. A posted car shows **Posted ✓**; clicking that unmarks it.

First run on a new machine: on the review screen, **Open the form and check fields only (nothing filled)** opens the form and only reports which fields Lot Current can find. From there: **Fill it in now**, **Check again**, **Copy report** or **Back**.

## Post several (the queue)

- On **Ready to post**, tick the cars you want, or tick **Select the next N** to take the first N in the order shown (after the search box, if you typed in it); the hint next to it says "Ticks the next N in this order". A tick stays while you search for the next car (the hint says how many ticked cars the search box is hiding), **Post N cars** counts every ticked car, and the queue takes them all in the order shown. The button reads **Post selected** until you tick, then **Post N cars**. Click it.
- On **To do**, **Queue all N ready arrivals** queues the new arrivals that are ready. It is there when more than one is ready; a single one has its own **Post** button.
- In the side panel's own **Ready to post** list, **Post the next N** queues the first N cars in the order shown (after the search box), skipping drafts, never more than the day's remaining cap.
- A queued car that was marked as posted meanwhile (from the list, the popup or a colleague's computer) is skipped, with a line saying so; it never gets a second form.
- The side panel takes the cars one at a time. A car that passes every check opens and fills the Marketplace form straight away. A car with a warning (including one you took down while the website still listed it) stops at the review screen so you see it. So does a car whose photos sit on a server Chrome has not been asked about yet: Chrome only asks when you click, so click **Open the Marketplace form**.
- For each car: check the form and click **Publish** on Facebook. The panel notices the listing and loads the next car. If it did not notice, click **It's posted, next car**. Prefer drafts? Click Facebook's **Save draft**, then **Saved as draft, next car**. **Skip, next car** moves on without posting. A car the re-check blocks offers **Skip this car, next**.
- The queue bar at the top of the panel: **Post next car**, **Pause**, **Resume**, **Skip this car**, **Stop queue**, and **Clear queue** when it is finished. In the popup, the Ready to post tab shows the same queue with **Continue in the side panel**, **Stop the queue** and **Clear**.
- The queue survives closing the panel. It can never be longer than the day's remaining cap, and it pauses when the cap is reached. Posted cars stay recorded when a queue is stopped.
- A car saved as a draft shows "Draft on Facebook" on Ready to post until you publish it on Facebook and click **Mark posted**.

## When a car sells or a price changes

Only cars marked as posted are watched: cars posted through the panel or marked with **Mark posted**. A to-do item for a car you did not mark shows greyed out with "not marked as posted" and no button.

**A sold car.** The **To do** tab lists it under **Take down**, with the reason (gone from the website, marked sold, or sale pending). The item stays on every rescan until you click **Taken down** or the website shows the car for sale again.

1. Click **Open listing**. The side panel opens your listing in a new tab.
2. On Facebook, click **Mark as sold** (or **Delete**) yourself. The panel notices ("The listing shows it as sold or removed") and ticks the item off.
3. If it does not notice, click **I took it down** in the panel. **Not now** leaves the item for later.
4. Took it down some other way? **Taken down** in the popup ticks the item off by hand.

**A price change.** The **To do** tab lists it under **Update price**, with the old price, the new price and the difference.

1. Click **Open & update price**. The panel opens your listing.
2. On Facebook, click **Edit listing**. The moment the Price box appears on this car's form, Lot Current puts the website's new price in it and the panel tells you what the box shows.
3. Click **Update** yourself. The panel notices the new price on the listing and ticks the item off. If not, click **I updated it**.
4. Updated it some other way? **Updated** in the popup ticks it off by hand.

Notes:
- If no listing link was saved for the car, the panel opens Marketplace's Your listings page instead and asks you to open the listing there.
- The panel only fills or ticks off when the tab is showing that car's listing. If you moved to another page it says "This tab isn't showing the listing for [car]".
- A post that is under way blocks a to-do item: finish or stop it first, then click the To do button again.
- **My listings** shows each car as "Matches the website", "Website price changed" (with **Updated**), "Website no longer shows a price", "Not on the website at the last scan", "Marked sold on the website", "Sale pending on the website", "Not pre-owned on the website" or "Needs a look (see To do)", with **Taken down** and, when a link was saved, **Open listing**.
- A car you posted that the website now calls new, demo or loaner, or whose details need a look, stays under **Needs a look** on every rescan until the website is fixed or you take the listing down and click **Taken down**.
- On a website Lot Current reads from the standard vehicle data on each car's page, a car that left the website but whose own page could not be checked (it gave an error, had no vehicle details, or sent Lot Current to another website) is not marked gone: it stays under **Needs a look** with the reason. Check the car on the website; if it sold, take your listing down and click **Taken down** on **My listings**. Other sold cars are still put under **Take down** as usual.
- On Dealer Inspire, DealerOn and Dealer.com websites, one failed check holds back every missing car for that scan: each shows under **Needs a look** as "Missing from this scan but not confirmed gone. Rescan later." and the scan says why. The next scan that checks them puts the sold ones under **Take down**.
- Signed in to your dealership's account, your colleagues' listings come under **Posted by colleagues**, below yours and not in the tab's count, with who posted each car and **Open listing** only. Ready to post shows "Posted by [name]" on such a car, and a sold car or price change on one is listed in To do as "posted by [name]", with no buttons: keeping it up to date is that colleague's to do.
- A car a colleague had already listed when your post of it reached your dealership's account is not added to the dealership's list: the list and the manager view keep your colleague's. Your listing is still yours on Facebook. To do then says how many of your posts were not shared, and the car in **My listings** says "Not shared with your dealership" and who has it listed, so you can decide with your colleague which listing stays. A post whose time is ahead of the server's clock is not shared either; the car says to check the computer's date and time.
- The posting rules ask for sold cars to come down the same day.

## The Numbers tab

**Numbers** shows the pilot numbers Lot Current records, kept in this browser, per website, and, while you are signed in, also in your dealership's account (all but the fields it couldn't fill, which stay in the browser):

- how long each post took, from the click on **Post** to **It's posted, record it**, your review included, and how each post you started ended: posted, saved as a draft, skipped in a queue, stopped by the re-check, not posted (**It didn't post**) or left open (abandoned);
- which form fields Lot Current could not fill, by field name only;
- how long sold cars and price changes stayed on your listings, from the scan that flagged them to the moment the change was seen or you ticked the item off.

Each post attempt and each to-do item names the car (its VIN and name), each post attempt your name from Settings and, when it stopped, the reason; a price change keeps the website's old and new price.

It never records buyers, messages, the description text or anything from your Facebook account beyond your own listings.

- **Download CSV** saves the spreadsheet to your Downloads folder; that is what your manager collects.
- **Copy summary** copies a short text for the weekly check-in.
- **Clear the numbers** needs two clicks (the button changes to "Click again to clear the numbers"). It keeps the to-do items still open (and a post under way), so they close as usual once you have dealt with them. While you are signed in, it also keeps the to-do items closed since the last sync until the next sync sends them (that is how your dealership's account learns they are done), and it does not remove what has already synced to your dealership's account.
- The numbers also prune themselves each time one is recorded: each list (post attempts, form fills, to-do items) keeps its newest 500 entries and nothing older than 90 days. An open to-do item stays until it is closed. Download the CSV before then if your manager wants the full record.

## Settings

Click **Settings** at the top of the popup, with your dealership's website open in the tab: settings are kept for each dealership website. On any other tab (Facebook, a new tab) Settings shows only **Account**, **Forget my synced profile** and **Report a problem**, and says to open your dealership's website. Click **Save settings** at the bottom, then **Rescan website** to apply. The sections:

- **You**: your name and your role, for the sign-off in every description, and **Your closing line (optional)**: a sentence of your own added after the sign-off, in place of "Message me to set up a test drive or ask a question." It is about you, not the car: no prices and no numbers other than a phone number, none of the phrases the checks ban, up to 30 words. A line that breaks these rules is not saved, and the popup says why.
- **Your store**: tick your store or stores. Leave all unticked to include every store.
- **New arrivals**: **Mark cars as new for N days** (1 to 30, 7 by default). Counted from the in-stock date the website gives for the car, or else from the scan that first saw it; a posted car is never marked new. This number, and the order of the Ready to post list, are kept for this website only and do not follow your profile to another website.
- **Dealership, named on every listing**: dealership name, city, state, ZIP. The scan fills these from the website; what you type wins. Marketplace suggests every town with the same name, and Lot Current only accepts the one in your state, so keep the state and ZIP filled.
- **Price to post**: the website's main price, or the lower second price the website shows (only offered when the website shows one; ask your manager first). A change applies to new posts: a listing you already posted keeps the price it was posted at, still checked against the website on that price (main or lower), so a change never asks you to edit a listing's price, and **My listings** says so on its line. Settings (and set-up's price step) says so before you save, with how many listings you have on the website. **Price note in every description** explains what the price includes. Lot Current suggests wording from the website's price gap but never fills it in for you.
- **Listing defaults**: **Title status** and **Vehicle condition**, filled in on every listing. "Leave blank" answers them per car on the form.
- **Safety**: **Posts per day, per salesperson**. See the daily cap below.
- **Posting rules**: **Read the posting rules** opens them, and the line under it says when you ticked that you will follow them for this website, or offers the tick until you have.
- **Automatic rescans**: the rescan tick, the desktop notification tick, and **Allow automatic rescans** when the permission has not been granted yet.
- **Description writer (optional)**: off by default. See below.
- **Terms and privacy**: today, a note that the Terms of Service and the Privacy Policy are being finalised and can be read and accepted here once they are published. From then on: links to both documents, the date and edition you accepted, and the tick "I have read and accept the Terms of Service and the Privacy Policy" until you have accepted the current edition.
- **Saved data**: **Clear everything for this website** and **Forget my synced profile**. See "Where the data lives" below.

Your profile follows you. Your name, role, closing line and listing defaults follow you to any dealership website. The dealership part (name, address, stores, price basis, price note and daily cap) belongs to that dealership's website and does not travel to another site. Both are kept in Chrome's synced storage under your own Google account, so they come back after clearing a website's data or reloading the extension.

## When a field could not be filled

The panel lists it under **Couldn't fill**, with the value Lot Current wanted to enter, the reason (what the form showed), and similar controls it saw on the page.

1. **Copy the report.** On that screen, the list itself is the report. For a fuller one, go back to the review screen and click **Open the form and check fields only (nothing filled)**, then **Copy report** on the result (read it before you send it: it holds the form page's address and title and the names of the controls on that page, which can include Facebook's own menus). Then click **Copy problem report** under **Report a problem** in **Settings**: it copies the version, the website, the last scan and the last fill's field names (no names, cars or links) for the same message.
2. **Send it** to support (`docs/support.md` says where and what else to include). Each fix is one line in the form map and comes back in the next zip.
3. **Fill it by hand.** Click **Copy** next to the value, paste it into the field on Facebook, and check the field before you publish. **Needs a click** means the value is in but the form wants a click to confirm it; click it.

Photos that would not attach: click **Download photos**, then add them from your Downloads folder on the form. If **Photos** says a server was not allowed, click **Allow photos from [server]** first: without that permission Lot Current can't download those photos either. If Facebook is set to another language, the panel says so: switch Facebook to English (Facebook's Settings, Language), then click **Fill again**.

## When Facebook restored a draft

Facebook sometimes opens the create-listing page with a saved draft or an unfinished listing already in it, often another car, and sometimes it restores that draft a few seconds after the page opens. Lot Current notices and puts a red banner in the panel:

- "This form already held another vehicle before Lot Current filled it": Lot Current replaced every field it manages, but photos and anything else from that draft may still be on the form.
- "Facebook changed [field] a few seconds after Lot Current filled it": Lot Current set the fields again and says whether they held.

What to do:

1. Check every field in the **Filled in** list against the form.
2. Remove the other car's photos from the form, or discard the draft on Facebook and click **Fill again**.
3. Delete that draft on Facebook so it stops coming back: Marketplace, Your listings, Drafts.
4. Only then click **Publish**.

Before a first day of posting, delete any old Marketplace drafts.

## When Chrome asks for a permission

Chrome only asks because you clicked something in Lot Current, and each prompt names particular websites: never every website, and never one of Facebook's servers. Five cases:

- **Allow automatic rescans** (in set-up, on the To do tab or in Settings): permission to read your dealership's website and its inventory service in the background, for the 3-hourly rescans. Allow it, or decline and scan by hand; the popup then says "Not allowed, so automatic rescans stay off."
- **Post**, **Post the next N** or **Rescan the website** in the side panel's own list, when the dealership website is not open in a tab: the same permission, so the panel can re-check the car or rescan without the tab. If you already allowed automatic rescans, Chrome does not ask again. Decline and the panel says "Not allowed, so Lot Current can't read [website] from the side panel"; open the website's used inventory page and post from the popup there instead, or click **Allow reading [website]** to be asked again.
- **Check with NHTSA (free government decoder)** in the side panel: permission to reach `vpic.nhtsa.dot.gov` for the VIN decode. Decline and the VIN is simply not checked online.
- **Photos from a server** in the side panel: permission to download a car's photos from the server they sit on, when it is not the photo host Chrome showed at install. Chrome asks when you click **Open the Marketplace form** (or **Fill it in now**, **Fill again** or **Download photos**) for the first car with photos there, one prompt for all of that car's servers. Lot Current only asks for the servers that car's own photos are on, only over https, and never for Facebook. Decline and the form still fills; those photos are not attached, and **Allow photos from [server]** asks again.
- At install, Chrome shows what the extension can read: `www.facebook.com/marketplace` and `vehicle-images.carscommerce.inc` (the Cars Commerce photo server used by the Dealer Inspire websites checked so far; any other photo server is asked for as above).

Lot Current never asks for your Facebook password, cookies or tokens, in Chrome's prompts or anywhere else.

## When the website scan fails

- "Can't read this page": the tab is not on your dealership's website. Open the used inventory page and click **Scan website** again.
- The website is not one Lot Current can read yet. Today it reads Dealer Inspire websites that use the Cars Commerce inventory search, and DealerOn and Dealer.com websites from their used inventory page. It also tries websites that publish standard vehicle data for search engines on each car's page. The DealerOn, Dealer.com and standard-data readers have been tested only on sample websites so far. Tell support which website yours is.
- "Couldn't see the list of cars this page loads" (DealerOn and Dealer.com websites): the page had not loaded its list of cars yet, or the tab is on a single car's page. Open the used inventory page, wait until the cars show, then click **Scan website** again.
- "Couldn't reach the dealership tab" during set-up: open the used inventory page, click the Lot Current icon and click **Continue set-up**.
- A warning that many cars vanished at once: on a lot of 10 cars or more, if more than half of it disappears between scans, nothing is marked gone and the last good scan is kept. Scan again later; if it repeats, tell support. A smaller lot has no such rule, so a car is marked gone only when the website's own search or the car's own page says it is no longer there, and an answer from the website that is not a list of cars stops the scan instead.
- "Automatic rescans are on, but Lot Current has no permission to read this website in the background": click **Allow automatic rescans** on the banner.
- "The last automatic rescan failed" (or "The last rescan from the side panel failed"): the website could not be read at that moment. A scan by hand still works; if it keeps failing, send the message to support.

## When the description writer is off

The description writer is off by default, and Lot Current works without it. Descriptions then come from the built-in template: the website's facts, 60 to 120 words, your sign-off and the VIN. **Rewrite with Claude** and **Guess from the photos** in the side panel are greyed out with the note "Turn on the rewrite service in Settings first".

To turn it on, your dealership needs the Lot Current rewrite service running and its address and key from whoever runs it. In **Settings**, **Description writer (optional)**: tick "Use the Lot Current rewrite service (Claude) for first drafts", enter **Service address** and **Service key**, and save. Either way, every draft goes through the same checks, and you review it before you post. If the service is unreachable or a draft fails a check, the template is used and the panel says so.

## The daily cap

Each salesperson may record a set number of posts a day, 10 by default. Your dealership chooses the number, and each salesperson enters it in their own **Settings**, **Safety**, **Posts per day, per salesperson** (1 to 100), with that website's other dealership settings. The manager view does not set it or show it, so ask your manager which number to use.

- The review screen shows "N of M posts today". At the cap, **Post** buttons and tick boxes go away on Ready to post, **Open the Marketplace form** is disabled, and a queue pauses. The message reads "Daily post cap reached (N of M today). It resets tomorrow; the dealer can change it in Settings."
- It counts posts recorded in this browser for this website today, including a post you took down later the same day (**Taken down**, or unmarking **Posted ✓**): taking a listing down never gives the slot back. Signed in, it is never lower than your dealership's account's count of your posts today, which includes the ones from your other computers.
- It is a safety setting, not a guarantee of anything from Facebook. Meta does not publish its limits.

## The manager view (for managers)

A web page your Lot Current contact gives you the address of. It shows your whole dealership once your salespeople sign in to their extensions (Settings, Account).

- **Sign in**: type your work email and click **Send me a sign-in link**. Open the link in the same browser on the same computer; it will not work in another browser. There is no password.
- **Start your dealership** (only once Lot Current's owner has opened sign-up; until then your Lot Current contact sets the dealership up and sends you an invite code, and the page says where it goes: in the extension, sign in under **Settings**, **Account** with the same email you use here, enter the code under **Invite code**, click **Join**, then reload the manager view): when you are signed in and your account is in no dealership yet, the page shows **Start your dealership**. Type the **Dealership name**, the **Website address** and **Your name**, then click **Start the dealership**. Under the address the page shows the website Lot Current will keep: it must match the address bar on the dealership's inventory pages, www included, because that is the website the extension syncs. You become the dealership's manager, its free pilot starts, and the page opens on it. If it can't be started, the page says why (for example, sign-up is not open, or that website already has a dealership) and keeps what you typed. If your store already uses Lot Current, don't start another one: ask its manager for an invite code and enter it in the extension under **Settings**, **Account**. Once your dealership is started, sign in to the extension with the same email (**Settings**, **Account**, or the set-up's **Your account** step). You are already in the dealership, so there is no invite code to enter: at the set-up step, click **Next**.
- **Getting started** (managers, above the other cards): four steps, each marked Done or To do with one sentence. **Start the free pilot or subscribe** (just **Start the free pilot** until paying by card opens); **Invite your salespeople** (an open invite code, or a second person in the dealership); **First car posted and synced** (any car a signed-in salesperson posted); **Two salespeople posting** (two different salespeople of the dealership posted in the past 7 days; a manager's own posts don't count, nor do those of someone no longer in the dealership). **Go to Billing** and **Go to Invite codes** take you to the card that does the step. Once all four are done, the card shrinks to one line.
- **Billing**: where the dealership's plan stands (no plan yet, free pilot with the days left, subscribed with the seats paid for, cancelled with the day it ends, or lapsed) and, for managers, **Start the free pilot**, **Subscribe** and **Manage billing** (Stripe's own pages, for the card and the invoices). When the plan has lapsed, salespeople can still post by hand, but nothing syncs and the description writer is off until it is renewed. When a payment did not go through, Stripe still holds the subscription open: the card says to update the card with **Manage billing** (there is no **Subscribe** then), and syncing starts again once Stripe takes the payment. Managers also see the seats: how many salespeople the dealership has, and how many the plan includes. Each person in the Team card with the salesperson role takes a seat; managers don't. **Subscribe** asks for a seat per salesperson, and never fewer than the plan includes; the card says how many, and Checkout shows the price before you pay. Once you are subscribed, if the dealership has more salespeople than seats paid for, the card says so: "Lot Current never adds seats or changes what you pay on its own: to add seats, ask your Lot Current contact." Until Lot Current opens paying by card, a manager still has **Start the free pilot** (no card), there is no **Subscribe** or **Manage billing**, and the card says "Paying by card is not open yet, so nothing is charged; to carry on after the free pilot, ask your Lot Current contact." A free pilot agreed with Lot Current shows its end date there, and a lapsed plan says to ask your Lot Current contact. While Lot Current's billing still runs in Stripe's test mode, the card says "Billing is in Stripe test mode: only Stripe's test cards work, nothing is charged, and a subscription started now does not carry over when real billing starts."
- **Invite codes**: **Invite a salesperson** or **Invite a manager** makes a code that works once and for 7 days; **Copy** puts it on the clipboard. The card lists every open code with the day it expires; **Revoke** cancels one that went to the wrong person. A code stops working when the manager who made it leaves the dealership or stops being a manager.
- **Team**: everyone in the dealership's account. **Make manager** and **Make salesperson** change a role; **Remove** takes two clicks and stops that person's extension from syncing (the cars they posted stay in the numbers, and any they still have listed show under **Listed by people no longer on the team**, because no extension flags a sale or a price change on them any more). A dealership always keeps at least one manager, so make someone else a manager before you step down or leave.
- **Salespeople**, **Sold cars still listed** and **Price changes not yet updated**: the same numbers the salespeople's Numbers tabs keep, for the whole store, with **Download CSV** for the spreadsheet. An item opens only when a rescan on the poster's own computer finds their car gone from the website or its price changed, so a salesperson whose Chrome stays closed for days is flagged when it next runs, and an empty card says "No open take-down items", not that every sold car is down, and also says when no scan is recorded yet or the last one is old.
- **Listed by people no longer on the team** (a manager's view only, and only when there are some): cars still marked listed by someone who was removed from the team. Nobody's rescans check them, so nobody is told when they sell or change price; check each against the website and have the person who posted it take it down or update it on Facebook, since the listing is on their own profile.

## What Lot Current never does

- Click Publish, Update, Delete or Mark as sold. Ever. There is no code for it, and a test that fails if any appears.
- Post or edit in the background or while you are away. Automatic rescans read your dealership's website and, while you are signed in to a Lot Current account, send that rescan's results to your dealership's account; they never touch Facebook.
- Post new, demo or loaner cars, or anything the pre-owned check cannot confirm.
- Invent prices or price drops. The listed price is the website price, and price changes only mirror the website.
- Make claims the website's data does not support, or hide that the car is at a dealership.
- Ask for, read or store your Facebook password, cookies or tokens; use fake delays, proxies or spoofing; or run more than your one account.
- Claim any affiliation with Meta. Lot Current is not affiliated with Meta Platforms, Inc.

Meta's Terms prohibit accessing its products "using automated means" without permission. Having a person click Publish is the safest design available, but it is not a guarantee. If Facebook ever warns you about your listings, stop and tell your manager.

## Where the data lives and how to clear it

**In this browser, per website:** the last scan, the to-do list, your posted list (and, for 30 days, the VIN and times of each listing you took off it, for the daily cap), your settings for that website (including the rewrite service key, which stays on this computer), the queue, drafts, set-up progress, a post under way, and the numbers on the Numbers tab (which prune themselves: each list keeps its newest 500 entries and nothing older than 90 days, open to-do items excepted). Each website's data is separate. When you sign in under Settings, Account, your posted list, your post timings, your to-do items and each scan's counts also sync to your dealership's account for the manager view: everyone at your dealership sees the posted list and the to-do items there, and only you and your managers see your post timings. The record of which form fields could not be filled stays here. Your sign-in itself is kept in this browser only, until you click **Sign out**.

**In Chrome's synced storage, under your own Google account:** your profile (name, role, closing line, dealership, stores, price basis, note, cap, listing defaults, rewrite service address, Terms acceptance). It follows you to other computers where you are signed in to Chrome.

**What leaves the browser, and when** (when you act, and on its own on the automatic rescans you allowed, with the sync after each one while you are signed in): reads of your dealership's website and its inventory service (each scan, and the rescans you allowed); while you are signed in, the sync with your dealership's account described above (after each scan, whether you click **Scan website** or it is an automatic rescan or one from the side panel; after each post, take-down or price update you record; when set-up finishes; when you sign in or join; and on **Sync now**; a sync our server asks to wait, because more than a dozen came in a minute, is tried again a minute later); the car's photos from the servers the website keeps them on (when a form is filled or **Download photos** is clicked); the NHTSA decode (when you click **Check with NHTSA (free government decoder)**); and, with the description writer on, the car's facts, the dealership name and city, your name and role, the price note, and, for a colour guess, up to four photo addresses and the list of colour words, sent to the rewrite service with your dealership website's address, which the service uses to know which dealership the request is for and does not pass on. Nothing from your Facebook account is sent anywhere.

**To clear it:**

- **Settings**, **Saved data**, **Clear everything for this website**. Click twice; the button changes to "Click again to clear everything". This removes everything above for this website, takes the website off the automatic rescan list and its count off the icon. The synced profile stays. While you are signed in, it does not remove what has synced to your dealership's account: the next sync brings your posted list and its open to-do items back to this computer.
- **Numbers**, **Clear the numbers** (two clicks) clears only the numbers for this website, except the to-do items still open and, while you are signed in, the ones closed since the last sync, until the next sync sends them.
- "Couldn't save: Chrome's storage for Lot Current is full. Clear the numbers on the Numbers tab, or open an old dealership website and click Clear everything for this website in Settings." Chrome gives Lot Current 10 MB for every website together, and each website's scans, drafts and numbers count toward it. First click **Clear the numbers** on the **Numbers** tab (download the CSV first if your manager still needs it). If that is not enough, open a dealership website you no longer post from, click the Lot Current icon, then **Settings**, **Saved data**, **Clear everything for this website**. Then do again what you were doing when the message appeared.
- Removing the extension at `chrome://extensions` removes what it kept on this computer.

## How to forget the synced profile

**Settings**, **Saved data**, **Forget my synced profile**. It removes the profile from Chrome's sync storage. The settings on this computer stay as they are. Only saving Settings or finishing set-up re-creates the profile; a scan or a sign-in does not. Clearing your Chrome sync data removes it too. Do this before removing the extension if you want nothing left behind.
