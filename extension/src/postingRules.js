// The posting rules shown to every salesperson on first run. The wording is
// the same as legal/posting-rules.md (a unit test keeps them in step); that
// file is the one an attorney reviews.

export const POSTING_RULES = Object.freeze([
  { title: 'You publish every post.', text: "Lot Sync fills in the Marketplace form and opens pages. You check the form and click Publish yourself, every time. Lot Sync never clicks Publish, Update, Delete or Mark as sold, and it never posts while you're away." },
  { title: 'Pre-owned cars only.', text: 'Lot Sync only lets through cars the dealership website says are used or certified used, and only cars at your store with photos and a price. Never post a new, demo or loaner vehicle on Marketplace, with Lot Sync or by hand.' },
  { title: 'The price is the website price.', text: "Post the price Lot Sync gives you (the dealership's chosen price basis) and change it only when the website changes. No made-up drops, no raising a price to lower it later, no deleting and reposting to bump a listing." },
  { title: 'Say who you are.', text: 'Every description names the dealership and your role. Write in your own voice, but never pose as a private seller.' },
  { title: 'Facts only.', text: "Say only what the website's data says. No \"no accidents\", \"best price in town\", \"everyone's approved\", nothing about the buyer's race, religion, family, disability or age. Lot Sync checks every number against the website and flags banned phrases; you are still responsible for what you publish. Lot Sync fills in the title status and condition from your dealership's defaults: if a car's title is branded (rebuilt, salvage, lien) or its condition isn't what the default says, change it on the form before you publish." },
  { title: 'Take sold cars down the same day.', text: "When Lot Sync's To do list says a car sold or went sale-pending, open the listing and mark it sold or delete it, then click Taken down. When a price changed, update the listing, then click Updated." },
  { title: 'Stay within the daily cap.', text: 'The dealership sets how many posts a day each salesperson may make (10 by default). It is a safety setting, not a guarantee of anything from Facebook.' },
  { title: 'Your account, your login.', text: "Post from your own Facebook account only. Lot Sync never asks for your password, never reads your cookies or messages, and never shares or automates accounts. Don't use tricks to look \"more human\", proxies or extra accounts." },
  { title: "Follow Facebook's rules.", text: "Meta's Terms of Service and Commerce Policies apply to you. They prohibit automated access without permission. Having you click Publish is the safest way to use Lot Sync, but no one can promise your account will never be restricted. If Facebook ever warns you about your listings, stop and tell your manager." },
  { title: 'Ads law applies.', text: "Vehicle ads must be truthful about price, fees and the dealership. Your dealership is responsible for its ads; Lot Sync gives you the website's price and a fee note to keep them honest." },
]);
