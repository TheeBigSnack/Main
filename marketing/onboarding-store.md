# Onboarding emails for a store-wide install

Three short emails for a dealership that has finished its pilot and is putting Lot Current on every salesperson's machine, with the used car manager leading: one to the manager before anything is installed, one to each salesperson, and a day-7 check-in to the manager. Sent by the owner. Fill in the brackets; every count or price that is not a bracket is quoted from `marketing/pricing.json` (`includedSalespeople`, `extraSalespersonMonthly`) and checked by `test/marketing.test.js`. The pilot's own emails are in `onboarding-emails.md`.

Before the first email goes out (`supabase/README.md`, "The first dealership and its manager"): the dealership's account exists with its website and the manager is on it as its manager. The manager makes the salespeople's single-use invite codes in the manager view (**Invite a salesperson** in its Invite codes card calls `create_invite`), and the email to the manager says so; the owner can make them instead with the same function in the SQL editor while signed in as the manager, which the email offers in one clause. `[code]` in the salesperson email is the code made for that person: fill it in when the manager has passed the codes on, or write "the code [manager] gives you" in its place. The Web Store link is the unlisted listing's address (`store/listing.md`); the manager view address is wherever `manager/` is hosted.

---

## To the manager: what happens next

**Subject:** Lot Current: what happens next at [dealership]

Hi [name],

Thanks for signing. Here is the whole roll-out in one email, so nothing is a surprise.

**1. The account.** I have set up [dealership]'s Lot Current account with [website address] as its website and added you as its manager. The pilot's listings need one step from each pilot salesperson, because the copy from the Chrome Web Store starts empty and cannot see what their pilot copy kept. My email to them walks through it: before installing from the store, they sign in and join the account in the copy they used during the pilot, so its posted list, post timings and to-do items sync to the account; when they sign in to the new copy, their posted list comes into it. They keep the pilot copy until the new copy's My listings shows their pilot cars. Until a pilot salesperson has done that step, their pilot listings are not in the manager view.

**2. Invite codes.** Each salesperson joins the account with an invite code that works once and for 7 days. You make the codes yourself in the manager view (step 4): under **Invite codes**, click **Invite a salesperson** and the code appears with a **Copy** button and the sentence to send with it. One code per person, [N] in all; a code belongs to one person, so please don't forward one. The card lists every code nobody has used yet, with the day it expires, and **Revoke** cancels one that went to the wrong person. A code you made stops working if you ever leave the store's account or stop being a manager. If you would rather I did it, send me the list (name and work email) and I will make the codes and email each person theirs. Either way, every salesperson gets the install steps below from me.

**3. Install.** Each salesperson installs Lot Current from the Chrome Web Store at [Web Store link], about two minutes, then runs set-up on [website address], which asks them to sign in with a code sent to their email (no password) and enter their invite code. My email to them walks through it step by step, and I'm reachable on [install day] for anyone who gets stuck.

**4. The manager view.** [manager view address] shows who posted what, which sold cars are still listed and for how long, and which price changes haven't reached the listing yet. Sign in with your email address: click **Send me a sign-in link** and open the link on the same device. There is no password. The view reads only what the salespeople's extensions record: VINs, listing links, prices and times. Nothing from Facebook beyond the links to their own listings, and never a description or a buyer.

**5. The posting rules.** Every salesperson reads them and ticks that they will follow them before their first post: in set-up, or in the side panel if they skipped set-up: a person publishes every post, pre-owned cars only, the website price only, the dealership named in every description, facts only, sold cars down the same day. They are at [posting rules address]. Please back them; they are what keeps the store's listings honest, and they are the store's listings.

**6. The daily cap.** Each salesperson may record [10] posts a day. It lives in each person's Settings (Safety, Posts per day, per salesperson), and the number in their install email is the one you choose, so tell me now if you want a different one. It is a safety setting, not a guarantee of anything from Facebook; Meta does not publish its limits.

**7. Seats.** The subscription includes five salespeople; each one beyond that is $20 a month, the figures you saw at purchase and in Schedule A of the agreement. Tell me when the list changes.

I'll write on day 7 with the three numbers to look at in the manager view.

Two things I will keep saying: Lot Current never clicks Publish, and it never asks anyone for their Facebook login. Having a person click Publish is the safest way to do this, not a guarantee. Lot Current is not affiliated with Meta.

[your name]
[phone]

---

## To each salesperson: install, sign in, first car

**Subject:** Lot Current: install, sign in and your first car (about fifteen minutes)

Hi [name],

[Manager] has put Lot Current on for everyone at [dealership]. It fills in a Facebook Marketplace listing from the website in seconds; you check it and click Publish yourself. Here is the whole set-up.

[Only for a salesperson who was in the pilot:] **Before you install: bring your pilot listings across (5 minutes).** The copy from the Chrome Web Store starts empty; it cannot see what the copy you used in the pilot kept. So first, in that pilot copy, open [dealership used inventory URL], click the Lot Current icon, then **Settings**, and under **Account** sign in and join the store as in step 3 below. [If that Account section says accounts are not set up yet, first unzip the attached zip over the same folder and click the reload icon on chrome://extensions, as for any update.] When the Account section shows a last sync time, your posted list, post timings and to-do items are in the store's account. Then do the steps below; in step 3 you only sign in, with the same email: you have already joined, so skip the invite code. Keep the pilot copy until **My listings** in the new copy shows your pilot cars, then remove it on chrome://extensions so only one copy is running.

**1. Install (2 minutes).** Open [Web Store link] in Chrome, click **Add to Chrome**, then **Add extension**. Chrome says the extension can read and change data on www.facebook.com/marketplace and on vehicle-images.carscommerce.inc, the Cars Commerce photo server used by the Dealer Inspire websites checked so far; that is what filling the form and attaching the photos needs. If your dealership's photos are on another server, Chrome asks for that one the first time you fill in a form for one of its cars. It never reads your Facebook password, cookies or messages. Then click the puzzle-piece icon in Chrome's toolbar and pin **Lot Current**.

**2. Set-up (about 7 minutes).** Open [dealership used inventory URL], click the Lot Current icon, and on the **To do** tab click **Set up Lot Current**. The side panel walks you through: reading the website, your store, your name and role, signing in and joining the store (step 3), the store's address (already filled from the website), the price to post and the price note that goes into every description (a suggested sentence is shown; only your store can say whether it is true), permission for automatic rescans (say yes so your To do list stays current), the posting rules and the Terms. Please read the rules once; they are short and they matter. The price note can be changed later under **Settings**.

**3. Sign in and join the store when set-up asks.** Right after your name and role, set-up asks you to sign in. Type your work email and click **Send me a sign-in code**, enter the six-digit code from the email and click **Sign in**. There is no password. Then enter your invite code, **[code]**, and click **Join**. It works once, for 7 days, and it is yours alone; if it has expired, ask [manager] for a new one. From then on your posted list syncs to the store's account: [manager] sees who posted what, and you can see which cars a colleague has already listed. If you skip this during set-up, do it later: click the Lot Current icon, then **Settings**, and use the same boxes under **Account**.

**4. Your first car.** First, on Facebook Marketplace, open Your listings, then Drafts, and delete any old drafts: Facebook sometimes puts a saved draft back onto a new listing form. Then click the Lot Current icon on the inventory page, **Ready to post**, then **Post** on a car. Read the description in the side panel (edit it if you like), click **Open the Marketplace form**, check every field on Facebook, especially condition and title, and click Publish yourself. Back in the panel, click **It's posted, record it**. The daily cap is [10] posts a day: click the Lot Current icon, then **Settings**, and under **Safety** make **Posts per day, per salesperson** read [10], then click **Save settings**. It's a safety setting, not a target.

Three sentences that matter:

- **You click Publish. Lot Current never does.** It fills in the form and opens pages; nothing is posted or edited while you're away.
- **Keep prices honest.** The price is the website price, and it changes only when the website changes. No made-up drops, no deleting and relisting to bump a car.
- **Clear the To do tab the day items appear.** When a car sells, click **Open listing** and mark it sold on Facebook yourself. When a price changes, click **Open & update price** and click Update yourself.

If the panel ever shows **Couldn't fill**, copy the report with the button and send it to blawrence@lotcurrent.com. Meta's Terms prohibit automated access without permission; having you click Publish is the safest way to do this, not a guarantee, and if Facebook ever warns you about your listings, stop and tell [manager]. Lot Current is not affiliated with Meta.

[your name]
[phone]

---

## Day 7, to the manager: three numbers

**Subject:** Lot Current: week one at [dealership], three numbers

Hi [name],

A week in. Open the manager view at [manager view address] and look at three things:

**1. Posted this week, per salesperson**, in the Salespeople table. Anyone at zero either hasn't finished set-up or hasn't found a first car to post, and a word from you does more than one from me. The median seconds per post is the time from Post to It's posted, their own review and Publish click included.

**2. Sold cars still listed.** The count in the heading should be zero, and a car on the list should be there for hours, not days: red means open for more than 24 hours. Each one is on that salesperson's To do tab with a button that opens the listing; they click Mark as sold on Facebook.

**3. Price changes not yet updated.** Same reading: zero, or hours. The listing price must match the website; Open & update price puts the new price in the box, and they click Update.

Above the table, the last-scan line says when a salesperson's extension last read the website. Rescans run every 3 hours while someone's Chrome is open with rescans allowed; if that line says more than 6 hours ago on a working day, nobody's Chrome had it on.

Three things the view can't show: a car listed by hand without clicking Mark posted in Lot Current isn't watched, so a sold one won't appear here; a car is flagged by the rescan on its poster's own computer, so someone away with Chrome closed is flagged when they are back (cars left listed by someone you removed from the team show under Listed by people no longer on the team, for you to chase); and the numbers are what the extensions recorded, nothing from Facebook itself. **Download CSV** at the top gives you the same rows in a spreadsheet.

Can we take ten minutes on [day] to go over it? Bring anything the salespeople have run into; every Couldn't fill report fixes something.

Lot Current is not affiliated with Meta. A person clicks Publish every time and Lot Current never does; that is the safest design available, not a guarantee.

[your name]
