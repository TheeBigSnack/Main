// Waits for something only an async check in the page can see: a value in
// chrome.storage, the toolbar badge. Playwright's waitForFunction does not
// await a check that returns a promise (the promise itself is truthy, so the
// wait ends at once), so this asks the page with evaluate until the check
// holds, and fails the flow when the time runs out.
export async function until(page, check, arg, { timeout = 10000, every = 100, what = 'the check' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(check, arg)) return;
    if (Date.now() >= end) throw new Error(`waited ${timeout} ms for ${what}`);
    await page.waitForTimeout(every);
  }
}
