// How a Marketplace listing page reads, in its static text (never button or
// link text), once the salesperson has acted on it. Used only to notice that
// the person has finished a To do item; Lot Sync never performs these actions.
//
// STATUS: NOT YET VERIFIED against live listing pages; proven against
// test/e2e/mock-marketplace.mjs. If a sign is wrong, the "I updated it" /
// "I took it down" buttons in the side panel still close the item by hand.

export const LISTING_SIGNS = Object.freeze({
  // The listing has been marked sold: Marketplace labels it "Sold". Tested
  // only against short standalone labels, never against prose, and only
  // counted when it appears after the page was first read.
  sold: '(^|\\s)sold(\\s|$|[.!])',
  // The listing was removed: the page no longer shows it (either apostrophe).
  unavailable: "isn[\\u2019']?t available|no longer available|has been removed|content not found|page not found",
});
