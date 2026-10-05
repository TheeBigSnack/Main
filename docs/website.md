# The website: how it is built, hosted and put on a domain

`site/` is the Lot Current website: plain HTML, CSS and one small ES module, committed as served. No build step, no framework, no bundler, no source maps, nothing loaded from another host (no fonts, scripts, analytics or CDNs: the pages' Content-Security-Policy allows only the site's own files and, from the two pages that run `site.js` (home and pricing), the `lead` function). This page is for the owner: what the site is made of, how to turn GitHub Pages on, how to point a domain at it, and what to fill in so the pages stop saying "not set" and "not open yet". The rules in `CLAUDE.md` apply to every word on it.

## What the site is made of

| Address | File | Written from |
|---|---|---|
| `/` | `site/index.html` | `site-src/pages/home.html` |
| `/how-it-works/` | `site/how-it-works/index.html` | `site-src/pages/how-it-works.html` |
| `/pricing/` | `site/pricing/index.html` | `site-src/pages/pricing.html` (the prices written into the page from `marketing/pricing.json` by `npm run site-pages`, which also writes `site/pricing.json` with only the numbers the pages show, never its reasoning or notes, for `site.js` to fill them in again) |
| `/faq/` | `site/faq/index.html` | `site-src/pages/faq.html` |
| `/for-managers/` | `site/for-managers/index.html` | `site-src/pages/for-managers.html` |
| `/support/` | `site/support/index.html` | `site-src/pages/support.html` |
| `/legal/` | `site/legal/index.html` | `site-src/pages/legal.html` |
| `/legal/terms/`, `/legal/privacy/`, `/legal/posting-rules/` | `site/legal/<name>/index.html` | `legal/terms-of-service.md`, `legal/privacy-policy.md`, `legal/posting-rules.md`, by `npm run legal-pages`; the old `site/legal/<name>.html` addresses are redirect stubs to the new pages |
| `/404.html` | `site/404.html` | `site-src/pages/not-found.html`; GitHub Pages serves it for any address that does not exist |
| `/robots.txt`, `/llms.txt` | `site/robots.txt`, `site/llms.txt` | the page map in `scripts/site-pages.mjs` |
| `/sitemap.xml`, `CNAME` | `site/sitemap.xml`, `site/CNAME` | the page map and `siteUrl`; written only once `siteUrl` is set, deleted while it is not |
| `/favicon.svg`, `/favicon.ico`, `/favicon-32.png`, `/apple-touch-icon.png` | `site/` | `site/favicon.svg` (the extension's mark) by `npm run favicons` |
| `/social/<page>.png` | `site/social/` | `site-src/social/template.html` by `npm run social-images`: the 1200 x 630 image behind each page's share tags |
| `/screenshots/*.png` | `site/screenshots/` | the sandbox, by `npm run screenshots` |

Two generators write every page: `npm run site-pages` (`scripts/site-pages.mjs`) renders each fragment under `site-src/pages/` into the shared document (head tags, header and navigation, breadcrumbs, footer, structured data) and writes the files next to the pages; `npm run legal-pages` (`scripts/legal-pages.mjs`) does the same for the three legal texts from their Markdown and writes the redirect stubs. Both have a `--check` mode that writes nothing and exits 1 when a committed file differs from what they would write; `npm test` runs both checks, so an output edited by hand, or a fragment, config or legal text changed without a rerun, fails the tests. The deploy uploads `site/` whole, so `site-pages` also names, and its `--check` refuses, any file there that is none of the site's: one no generator writes, that is not kept by hand (`KEPT_FILES` in `scripts/site-pages.mjs`: `config.js`, `site.css`, `site.js`, `favicon.svg`) and that no page shows. A page written by hand, the old file of a page dropped from the map, or a screenshot no page uses is caught that way; the generator never deletes it for you. Never edit a generated file by hand: change the fragment, the config or the Markdown and run the generator.

Every page has its own title (the brand last, at most 60 characters), its own description (at most 155), exactly one `h1`, a canonical address, Open Graph and Twitter card tags with its share image, a favicon, structured data (Organization, WebSite and SoftwareApplication on the home page, a BreadcrumbList on every other page, FAQPage on the FAQ; LocalBusiness in place of Organization once the business's address is in `site/config.js`; once `pricing.json` is no longer a hypothesis, the SoftwareApplication's Offer gives the price per rooftop per month, never a bare price. Google's Rich Results Test reports the SoftwareApplication as not eligible for a rich result because it carries no rating or review, and, while `pricing.json` is a hypothesis, no Offer either; that is by design, since the site never writes a rating, a review or a price it does not have) and visible breadcrumbs on every page but the home page. The addresses have no `.html`: each page is a folder's `index.html`, which GitHub Pages serves at the folder's address.

## The one place the site's address lives: `site/config.js`

Everything that needs the site's absolute address or an inbox comes from `SITE` in `site/config.js`, and nothing there is guessed: a value stays `''` until the owner has the real thing, and the pages, the generators and the tests say so.

| Field | What it is | While it is empty |
|---|---|---|
| `siteUrl` | The site's address once the domain exists: an https origin, no path, no trailing slash | No canonical, `og:url`, `og:image`, `sitemap.xml` or `CNAME` is written; `node scripts/site-pages.mjs --check` and `npm test` report "siteUrl is not set: the site is not ready to publish" as a condition (not a failure) |
| `demoEndpoint` | The `lead` Edge Function's address (`supabase/README.md`, "Demo requests"); set the function's `LEAD_ORIGINS` secret to `siteUrl` | With `demoMailto` also empty, the home page says the demo request form is not open yet and shows no address |
| `demoMailto` | `mailto:` plus a real inbox: the form's action without JavaScript and the fallback when `demoEndpoint` is empty | As above. A reserved placeholder domain (`.example`, `example.com` and the like) is refused by the generator and the tests |
| `supportEmail` | A plain address, shown on `/support/` | The support page tells people to ask the person who set Lot Current up for their store |
| `signupUrl` | The manager view's address, once self-serve sign-up is open | Nothing about sign-up shows |
| `business` | The entity's name and registered address (`name`, `streetAddress`, `addressLocality`, `addressRegion`, `postalCode`, `addressCountry`) and the optional `legalName`, `telephone`, `email`, `url`, `openingHours`, `areaServed` | The home page carries an Organization record; with every required field filled it carries LocalBusiness instead; half filled, the generator refuses to write. It is the Lot Current entity's address, never a dealer's |

After any change there: `npm run site-pages`, `npm run legal-pages`, `npm test`, commit the outputs with the config.

## Hosting: GitHub Pages from this repository, at https://lotcurrent.com

The site is served by GitHub Pages from `site/`, deployed by `.github/workflows/pages.yml` with GitHub's own actions (`configure-pages`, `upload-pages-artifact`, `deploy-pages`). Pages is free for a public repository; GitHub's documentation says a private repository needs one of its paid plans, so check GitHub's current pricing before making this repository private (`HANDOFF.md` lists that as something the owner wanted), or move `site/` to a public repository of its own first.

**When it deploys.** On every push to the repository's default branch, and by hand (**Actions**, **Pages**, **Run workflow**, on the default branch). The workflow reads the default branch's name from the repository, so nothing in it names a branch and renaming the default branch needs no change. A push to any other branch (a `claude/*` work branch, a pull request's branch) starts the workflow, and its deploy job is skipped. Merging a pull request into the default branch is therefore what publishes the site. The job runs `node scripts/site-pages.mjs --check` and `node scripts/legal-pages.mjs --check` first and refuses to deploy a tree whose committed pages differ from their sources, then `npm test` (the unit tests CI's `unit` job runs, Node only) and refuses to deploy when any of them fails, then uploads `site/` and deploys it. It does not wait for the CI workflow, so the unit tests are what keep a push that breaks the site's honesty rules or `site/pricing.json` off the live site.

**What is already set up on GitHub** (2026-10-01, by the owner): Settings, Pages has **Source** set to **GitHub Actions** (not "Deploy from a branch", which would serve the repository's root and ignore the workflow); the custom domain `lotcurrent.com` is saved with a successful DNS check; **Enforce HTTPS** is ticked; and the domain is verified on the owner's account (the account's own Settings, Pages, which keeps any other GitHub user from claiming it).

## The domain: lotcurrent.com

Registered at GoDaddy, with GoDaddy's DNS. The records that point it at GitHub Pages are the ones in GitHub's documentation page [Managing a custom domain for your GitHub Pages site](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site); copy them from that page, never from memory, if they ever need to be entered again. As of 2026-10-01 the domain has:

- the apex `lotcurrent.com`: GitHub Pages' four A and four AAAA records;
- `www.lotcurrent.com`: a CNAME to the account's `github.io` host, so GitHub redirects `www` to the apex;
- the TXT record `_github-pages-challenge-<account>` that verifies the domain on the owner's GitHub account (it must stay);
- the mail records GoDaddy's mailbox setup added (MX, SPF and its own TXT), for `blawrence@lotcurrent.com`.

`site/CNAME` (written by `npm run site-pages` from `siteUrl`) holds `lotcurrent.com` and is deployed with the pages; with the GitHub Actions source GitHub reads the custom domain from Settings, and the two agree.

## What `site/config.js` holds now

- `siteUrl: 'https://lotcurrent.com'`: every page carries its canonical, `og:url` and `og:image` on that domain, and `sitemap.xml` and `CNAME` are written.
- `demoMailto: 'mailto:blawrence@lotcurrent.com'` and `supportEmail: 'blawrence@lotcurrent.com'`: the home page's demo form is open and, with no `demoEndpoint`, sends through the visitor's email app; the support page shows the address. A role address (such as a support inbox) can replace it later: change both values, rerun the generators, commit.
- `demoEndpoint: ''` (by choice: the form sends through `demoMailto`. The `lead` function is deployed on the production project (`docs/production-setup.md`, step 3), and, if what was deployed is this repository's code (`docs/production-setup.md` step 3's **verify** compares the two), it refuses every request until its `LEAD_ORIGINS` secret names `siteUrl`; to send the form through it, set the `LEAD_ORIGINS` secret to `siteUrl` and `demoEndpoint` to the function's address, item 1 under "After a deploy" below), `signupUrl: ''` (no hosted manager view), `business` empty (Organization structured data only, the owner's decision).

After any change there: `npm run site-pages`, `npm run legal-pages`, `npm test`, commit the outputs with the config. The site's own host is exempt from `test/dataInventory.test.js`'s outside-host scan (it is this site, not an outside host); the tests pass with `siteUrl` set or empty.

## After a deploy

Open `https://lotcurrent.com/` and check: every page's browser tab shows its own title; `https://lotcurrent.com/does-not-exist/` shows the custom 404 page; `https://lotcurrent.com/legal/terms.html` lands on `/legal/terms/`; `https://www.lotcurrent.com/` redirects to the apex; and a demo request sent from the home page opens a message to the inbox. `npm run test:site` checks the same things against the committed files in a browser: CI's `demo` job runs it on every push and pull request, but neither a merge nor the deploy waits for it, so check that job is green before merging a site change. The job starts only once CI's unit tests pass, and runs `test:site` last, after the sandbox drive and `npm run test:a11y`: when either of those fails, `test:site` does not run at all, so a red `demo` job may mean the site was never checked.

Still to do, each when the owner chooses or its condition is met:

1. The demo form through the `lead` function (deployed already), when requests should land in the database instead of the inbox: set `demoEndpoint` to the function's address and the function's `LEAD_ORIGINS` secret to `siteUrl` (`supabase/README.md`, "Demo requests"), rerun `npm run site-pages`, commit. `LOTSYNC_SITE_ORIGIN=<siteUrl> npm run check-deploy` then shows both lead lines as ok.
2. The business details (optional): `business`, only with the entity's real registered address; see the launch checklist's item.
3. Once the legal texts are final (`legal/legal-status.json` says `"draft": false` and `npm run legal-pages` has rewritten the pages without their draft banners), give `extension/src/legalLinks.js` the three addresses `https://lotcurrent.com/legal/terms/`, `https://lotcurrent.com/legal/privacy/` and `https://lotcurrent.com/legal/posting-rules/` and a new `version`, so the wizard's Terms step starts recording acceptances of the texts people can read (the comment in that file says why not before).

## What the checks verify

- `npm test` (`test/sitePages.test.js`, `test/siteGenerator.test.js`, `test/site.test.js`, `test/legalPages.test.js`, `test/siteImages.test.js`, `test/dataInventory.test.js`): every page of the map exists; titles unique and at most 60 characters; descriptions unique and at most 155; exactly one `h1`; canonical and share tags consistent with the `siteUrl` state; breadcrumbs matching each address; every internal link and asset resolving to a file under `site/` (anchors included); the sitemap, `robots.txt`, `llms.txt` and `CNAME` as the generator writes them; every structured-data block parsing with its `@context` and `@type`; no page naming Vite, React, lorem, TODO, placeholder, a reserved placeholder domain or "Welcome to"; no `.map` file under `site/`; no script over 50 KB; every image with alt text and dimensions; the favicon files at their sizes and each share image at 1200 x 630 and at most 300 KB; the honesty word lists in `test/honesty.js` (no guarantee, no promise about anyone's Facebook account, no Meta approval or partnership, no made-up numbers) over every page's text, image alt text and head, the share-image sentences and `llms.txt`; no dollar figure that is not in `pricing.json` in the same places except image alt text, which describes the sample cars' prices in the screenshots and so is read only by the word lists; and both generators' `--check` modes. A word list catches the usual ways of writing those claims, not every possible one, so new copy still needs a person to read it against `CLAUDE.md`.
- `npm run test:site` (`scripts/site-check.mjs`): serves `site/` like Pages (folder index pages, a redirect to the slashed address, `404.html` with status 404), opens every page in headless Chromium and fails on any console error or warning, any failed request (the favicon and every share image included) or Content-Security-Policy violation; asserts the live `document.title`, the canonical, the one `h1` and the navigation's current-page mark; visits each redirect stub and a missing address.
- `npm run test:a11y` (`scripts/a11y.mjs`): every page at a desktop and a phone width, in light and dark, walked with the Tab key.

CI runs `npm test` in the `unit` job and `npm run test:a11y` and `npm run test:site` in the `demo` job; the Pages workflow runs the two `--check` modes and `npm test` before every deploy (not the browser checks, which need `npm ci` and Chromium: those gate only CI).

## Images

`npm run favicons` draws `site/favicon-32.png`, `site/apple-touch-icon.png` and `site/favicon.ico` from `site/favicon.svg` in headless Chromium; `npm run social-images` draws one 1200 x 630 PNG per page into `site/social/` from `site-src/social/template.html`, with the page's share heading from the page map. Rerun them after changing the mark, the template or a heading; `npm run screenshots` redraws the product images after a popup, side panel or sandbox change. All three need Playwright's Chromium (`npm ci`, `npx playwright install chromium`, or `LOTSYNC_CHROME=<path to a Chrome>`).
