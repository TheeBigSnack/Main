# Dealer-branding check harness

Measures the dealer-branding check, `extension/src/photoBranding.js` (imported
as it ships, never a copy), on synthetic car galleries in headless Chromium.
Run it again whenever the module, its `TUNING` or the way the side panel
decodes photos changes.

What the check does, and what it doesn't: it only crops. A cleaned photo is
always an exact sub-rectangle of the website's photo; nothing is painted over,
blurred, recoloured or invented. It cuts strips off the edges (a logo band, a
top bar, a frame, the strip a corner logo sits in). A see-through watermark, a
logo in the middle of the photo, or branding on the car itself (a plate frame,
a sticker) stays as it is. The salesperson sees every cropped photo before
posting and can use the original.

## Run it

```
node scripts/branding-eval/run.mjs               # every scenario, 1 seed, plus timing (about 3 minutes)
node scripts/branding-eval/run.mjs --seeds=2     # each scenario with 2 different cars and scenes
node scripts/branding-eval/run.mjs bottom-band neg-studio   # only these scenarios
node scripts/branding-eval/run.mjs --sheets      # also a contact sheet per scenario (PNG)
node scripts/branding-eval/run.mjs --tuning='{"tol":10}'    # override module constants
node scripts/branding-eval/table.mjs results-seeds.json [--groups]   # Markdown tables
node scripts/branding-eval/sweep.mjs '[["base",{}],["tol 10",{"tol":10}]]' [--seeds=2]
```

Other flags of `run.mjs`: `--quality=low` (decode with
`imageSmoothingQuality` 'low'), `--no-timing`, `--detail` (every photo's
metrics in the results file), `--out=name.json`.

Needs only the repo's Playwright (`npm ci`) and a Chromium, found the way
`demo/drive.mjs` finds it (the shared `chromePath()` of
`scripts/site-check.mjs`): the Chrome-path environment variable named
there, else
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` when it exists, else
Playwright's own (`npx playwright install chromium`). Nothing is written into
the repository: results files, sweeps and contact sheets go to
`lot-current-branding-eval/` under the OS temp folder, and the path is printed.

`run.mjs` exits 1 on any false crop, any lie, or any flag on a negative.
Those three must stay at 0 for a change to ship; misses may move.

## What the metrics mean

Each scenario builds a gallery (20 photos unless it says otherwise), lays a
made-up vendor overlay over the photos it names, saves them as JPEG (and, in
some, resizes them again the way an image CDN does), decodes them the way the
side panel does, runs `findBranding`, and measures every crop at full size
against the overlay's known transparency.

- **expect**: `pos` (every photo carrying an opaque overlay should be cropped
  clean), `neg` (no overlay: nothing may be cropped or kept), `see` (a
  see-through watermark only: the check does not look for these, so `none` is
  the expected answer and is counted as a miss), `kept` (an opaque logo inside
  the photo: reported, never cropped as clean).
- **false crops**: photos cropped that carry no overlay. Must be 0.
- **false flags**: photos without an overlay reported as still carrying one
  (`kept`). Must be 0 on negatives.
- **lies**: a crop that says nothing is left while an opaque overlay pixel
  (alpha over 127) is still inside it, or that leaves a see-through-only mark
  inside. Must be 0.
- **misses**: overlay photos not cropped (too few photos, an overlay on under
  80% of them, a see-through watermark). A miss leaves the photo as the website
  shows it; it is safe, only less useful.
- **opqL**: most opaque overlay pixels left in a crop called clean (0).
- **fringe / maxA / strip**: see-through overlay pixels left in a crop (a soft
  shadow past a band, a watermark), their strongest alpha, and the heaviest
  row or column of them.
- **lost %**: the share of clean (overlay-free) picture a crop cut off, mean
  and worst.
- **checkms**: time for `findBranding` on the scenario; the `timing` lines time
  decode, check and one crop for 20 and 40 photos at 1024x768 and 2048x1536.

## The galleries are synthetic

Every photo is procedural: scenes from gradients, SVG noise and shapes; cars
drawn as shapes; overlays carrying made-up text only (EXAMPLE AUTO GROUP,
555-0100, example-auto.test). There is no real dealer, photo, logo, phone
number or website anywhere in this folder, and none may be added to it.
Scenarios cover bottom bands, top bars, frames, corner badges and tabs,
see-through and shadowed bands, cover-only banners (checked against other
cars' covers, the lot), CDN resizing, small galleries, duplicates, mixed
sizes, placeholders, and the hard negatives: a fixed camera, a booth with a
poster, the same spot for every car, letterboxing.

## Adding a real gallery later

Only with the owner's OK. Put the dealer's photos for one or more cars in a
folder outside the repository (or in a folder that is never committed), one
subfolder per car, in the website's order. A real gallery has no known
overlay mask, so the measure is a person's review: load each car's photos
into the harness page (the same `decodeSample` and `findBranding` calls
`evaluate.js` makes), write the contact sheet (`--sheets` shows the pattern),
and check by eye that every crop cuts only the overlay and that photos
without it are not cropped. Never commit photos, contact sheets or results
that name or show a dealer.
