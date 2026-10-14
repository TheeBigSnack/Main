// Closes a Playwright browser context, waiting at most ms. Playwright waits for
// the browser process to exit with no timer of its own, so a browser that never
// exits would hold the run, and its memory, forever (HANDOFF 26.4). Returns true
// when the context closed (or was already gone), false when the wait ran out.
export async function closeBounded(context, ms = 15000) {
  let timer;
  const closed = await Promise.race([
    context.close().then(() => true, () => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  return closed;
}
