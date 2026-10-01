# The website: how it is built, hosted and put on a domain

`site/` is the Lot Sync website: plain HTML, CSS and one small ES module, committed as served. No build step, no framework, no bundler, no source maps, nothing loaded from another host (no fonts, scripts, analytics or CDNs: the pages' Content-Security-Policy allows only the site's own files and, from the home page, the `lead` function). This page is for the owner: what the site is made of, how to turn GitHub Pages on, how to point a domain at it, and what to fill in so the pages stop saying "not set" and "not open yet". The rules in `CLAUDE.md` apply to every word on it.

## What the site is made of

| Address | File | Written from |
|---|---|---|
| `/` | `site/index.html` | `site-src/pages/home.html` |
| `/how-it-works/` | `site/how-it-works/index.html` | `site-src/pages/how-it-works.html` |
| `/pricing/` | `site/pricing/index.html` | `site-src/pages/pricing.html` (the prices from `site/pricing.json`, a copy of `marketing/pricing.json`) |
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

Two generators write every page: `npm run site-pages` (`scripts/site-pages.mjs`) renders each fragment under `site-src/pages/` into the shared document (head tags, header and navigation, breadcrumbs, footer, structured data) and writes the files next to the pages; `npm run legal-pages` (`scripts/legal-pages.mjs`) does the same for the three legal texts from their Markdown and writes the redirect stubs. Both have a `--check` mode that writes nothing and exits 1 when a committed file differs from what they would write; `npm test` runs both checks, so an output edited by hand, or a fragment, config or legal text changed without a rerun, fails the tests. Never edit a generated file by hand: change the fragment, the config or the Markdown and run the generator.

Every page has its own title (the brand last, at most 60 characters), its own description (at most 155), exactly one `h1`, a canonical address, Open Graph and Twitter card tags with its share image, a favicon, structured data (Organization, WebSite and SoftwareApplication on the home page, a BreadcrumbList on every other page, FAQPage on the FAQ; LocalBusiness in place of Organization once the business's address is in `site/config.js`) and visible breadcrumbs on every page but the home page. The addresses have no `.html`: each page is a folder's `index.html`, which GitHub Pages serves at the folder's address.

## The one place the site's address lives: `site/config.js`

Everything that needs the site's absolute address or an inbox comes from `SITE` in `site/config.js`, and nothing there is guessed: a value stays `''` until the owner has the real thing, and the pages, the generators and the tests say so.

| Field | What it is | While it is empty |
|---|---|---|
| `siteUrl` | The site's address once the domain exists: an https origin, no path, no trailing slash | No canonical, `og:url`, `og:image`, `sitemap.xml` or `CNAME` is written; `node scripts/site-pages.mjs --check` and `npm test` report "siteUrl is not set: the site is not ready to publish" as a condition (not a failure) |
| `demoEndpoint` | The `lead` Edge Function's address (`supabase/README.md`, "Demo requests"); set the function's `LEAD_ORIGINS` secret to `siteUrl` | With `demoMailto` also empty, the home page says the demo request form is not open yet and shows no address |
| `demoMailto` | `mailto:` plus a real inbox: the form's action without JavaScript and the fallback when `demoEndpoint` is empty | As above. A reserved placeholder domain (`.example`, `example.com` and the like) is refused by the generator and the tests |
| `supportEmail` | A plain address, shown on `/support/` | The support page tells people to ask the person who set Lot Sync up for their store |
| `signupUrl` | The manager view's address, once self-serve sign-up is open | Nothing about sign-up shows |
| `business` | The entity's name and registered address (`name`, `streetAddress`, `addressLocality`, `addressRegion`, `postalCode`, `addressCountry`) and the optional `legalName`, `telephone`, `email`, `url`, `openingHours`, `areaServed` | The home page carries an Organization record; with every required field filled it carries LocalBusiness instead; half filled, the generator refuses to write. It is the Lot Sync entity's address, never a dealer's |

After any change there: `npm run site-pages`, `npm run legal-pages`, `npm test`, commit the outputs with the config.

## Hosting: GitHub Pages from this repository

The site is served by GitHub Pages from `site/`, deployed by `.github/workflows/pages.yml` with GitHub's own actions (`configure-pages`, `upload-pages-artifact`, `deploy-pages`). Pages is free for a public repository; GitHub's documentation says a private repository needs one of its paid plans, so check GitHub's current pricing before making this repository private (`HANDOFF.md` lists that as something the owner wanted), or move `site/` to a public repository of its own first.

To turn it on, once:

1. In the repository on GitHub: **Settings**, **Pages**, under **Build and deployment** set **Source** to **GitHub Actions**. Do not pick "Deploy from a branch": that source would serve the repository's root, not `site/`, and would ignore the workflow.
2. Confirm the default branch under **Settings**, **General**, **Default branch**. The workflow deploys on every push to `master` (the branch the local checkouts use); if the default branch is named something else, change the one line `branches: [master]` in `.github/workflows/pages.yml` to that name. Work branches such as `claude/*` never deploy.
3. Run the first deploy by hand: **Actions**, **Pages**, **Run workflow**. The job runs `node scripts/site-pages.mjs --check` and `node scripts/legal-pages.mjs --check` first and refuses to deploy a tree whose committed pages differ from their sources, then uploads `site/` and deploys it. The deployment's address is printed on the run and under Settings, Pages.
4. Until the domain exists the site is at `https://<owner>.github.io/<repo>/`. Every link, stylesheet and image on the pages is relative, so the whole site works at that address, with one exception: the custom 404 page's links are root-relative (`/`, `/pricing/` and so on), because GitHub Pages serves `404.html` at any depth; on the `<owner>.github.io/<repo>/` address they point at the account's root instead of the site. That is the one thing the domain fixes, and nothing in the repository is changed to work around it.

While `siteUrl` is empty the pages carry no canonical or share address and there is no sitemap, so a deploy at this stage is for looking at the site, not for search engines. The home page's demo form says it is not open yet until `demoEndpoint` or `demoMailto` is set.

## The domain

Buying the domain is the owner's purchase (`CLAUDE.md`: ask before spending). Any registrar will do; what matters is that its DNS records can be edited.

**The DNS records.** GitHub documents the records for a custom domain on one page: [Managing a custom domain for your GitHub Pages site](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site). This document was written from a machine whose network blocks `docs.github.com` (the fetch was refused by the egress proxy), so the page could not be read and quoted here, and no IP address or CNAME target is given: copy the records from that page, not from memory and not from any other source, because GitHub changes them and a stale address would point the domain at nothing. The page covers both shapes of domain: an apex domain (the bare name with no `www`, which takes address records) and a `www` or other subdomain (which takes a CNAME record), with the command to check each record from the terminal. Set up the one the owner chose as `siteUrl`, and GitHub's page also says how to make the other redirect to it.

**Adding the domain to the site.** In the repository: **Settings**, **Pages**, **Custom domain**: type the hostname (the one in `siteUrl`, without `https://`) and save. GitHub checks the DNS records; a warning there means a record is wrong or has not propagated yet. With the GitHub Actions source, GitHub does not commit a `CNAME` file to the repository (it does that only for the branch source); ours is written by `npm run site-pages` into `site/CNAME` from `siteUrl` and deployed with the pages, so the two agree once `siteUrl` is set and the generator has been run. Setting the custom domain in Settings before `site/CNAME` exists works too; the next deploy carries the file.

**Verifying the domain.** GitHub lets an account verify a domain so that no other GitHub user can take it over while no deploy is serving it: it is done in the account's own settings (the profile's, not the repository's), under Pages, by adding the domain and the TXT record GitHub then asks for. Do it before the site goes live; GitHub's page above has the exact steps.

**HTTPS.** Once the DNS records resolve, GitHub issues a certificate on its own; it can take a while. When Settings, Pages stops saying the certificate is being issued, tick **Enforce HTTPS**. `siteUrl` is an https address, the canonical and share tags say https, and the `lead` function's `LEAD_ORIGINS` compares the exact origin, so the site must answer over HTTPS before the demo form can work.

## Once the domain exists

1. In `site/config.js` set `siteUrl` to the https origin (`https://` plus the hostname, nothing after it).
2. Run `npm run site-pages` and `npm run legal-pages`. The first now writes `site/sitemap.xml` and `site/CNAME` and puts the canonical, `og:url` and `og:image` addresses on every page; the second rewrites the legal pages and their redirect stubs with their canonicals. `node scripts/site-pages.mjs --check` now reports "siteUrl is https://...: canonical, og:url, og:image, sitemap.xml and CNAME are written" instead of "not set".
3. Run `npm test`. The tests that cover the site (`test/sitePages.test.js`, `test/siteGenerator.test.js`, `test/site.test.js`, `test/legalPages.test.js`, `test/siteImages.test.js`) require everything consistent with `siteUrl`: every canonical and `og:url` on the page's own address, the sitemap listing exactly the public pages (never the 404 page), `robots.txt` naming the sitemap, the `CNAME` file holding the hostname, `llms.txt` with absolute addresses.
4. `test/dataInventory.test.js` scans every HTML and script under `site/` for the hosts they name and requires each one on the "outside hosts" line of `docs/data-inventory.md` (`schema.org`, named by the structured data as a vocabulary and never contacted, is there already). The site's own host, `new URL(SITE.siteUrl).hostname`, is exempt from that scan: it is this site, not an outside host. Anything else that turns up there is a page loading from elsewhere, which the site must not do.
5. Commit `site/config.js` with the generated outputs and push to the default branch; the Pages workflow deploys. Then run `npm run test:site` against the committed files (it serves `site/` locally the way Pages does and opens every page in headless Chromium) and open the live site: the browser tab shows each page's own title, never a framework's; `https://<domain>/does-not-exist/` shows the custom 404 page; `https://<domain>/legal/terms.html` lands on `/legal/terms/`.
6. The demo form: set `demoEndpoint` (and the function's `LEAD_ORIGINS` secret to `siteUrl`: `supabase/README.md`, "Demo requests") or `demoMailto`, rerun `npm run site-pages`, commit. `LOTSYNC_SITE_ORIGIN=<siteUrl> npm run check-deploy` then shows both lead lines as ok.
7. The support address: `supportEmail`, together with the inbox items in `docs/launch-checklist.md` (the same address goes into `docs/support.md` and `store/listing.md`).
8. The business details (optional): `business`, only with the entity's real registered address; see the launch checklist's item.
9. Once the legal texts are final (`legal/legal-status.json` says `"draft": false` and `npm run legal-pages` has rewritten the pages without their draft banners), give `extension/src/legalLinks.js` the three addresses `https://<host>/legal/terms/`, `https://<host>/legal/privacy/` and `https://<host>/legal/posting-rules/` and a new `version`, so the wizard's Terms step starts recording acceptances of the texts people can read (the comment in that file says why not before).

## What the checks verify

- `npm test` (`test/sitePages.test.js`, `test/siteGenerator.test.js`, `test/site.test.js`, `test/legalPages.test.js`, `test/siteImages.test.js`, `test/dataInventory.test.js`): every page of the map exists; titles unique and at most 60 characters; descriptions unique and at most 155; exactly one `h1`; canonical and share tags consistent with the `siteUrl` state; breadcrumbs matching each address; every internal link and asset resolving to a file under `site/` (anchors included); the sitemap, `robots.txt`, `llms.txt` and `CNAME` as the generator writes them; every structured-data block parsing with its `@context` and `@type`; no page naming Vite, React, lorem, TODO, placeholder, a reserved placeholder domain or "Welcome to"; no `.map` file under `site/`; no script over 50 KB; every image with alt text and dimensions; the favicon files at their sizes and each share image at 1200 x 630 and at most 300 KB; the honesty rules of `CLAUDE.md` over every page's text; and both generators' `--check` modes.
- `npm run test:site` (`scripts/site-check.mjs`): serves `site/` like Pages (folder index pages, a redirect to the slashed address, `404.html` with status 404), opens every page in headless Chromium and fails on any console error or warning, any failed request (the favicon and every share image included) or Content-Security-Policy violation; asserts the live `document.title`, the canonical, the one `h1` and the navigation's current-page mark; visits each redirect stub and a missing address.
- `npm run test:a11y` (`scripts/a11y.mjs`): every page at a desktop and a phone width, in light and dark, walked with the Tab key.

CI runs `npm test` in the `unit` job and `npm run test:a11y` and `npm run test:site` in the `demo` job; the Pages workflow runs the two `--check` modes before every deploy.

## Images

`npm run favicons` draws `site/favicon-32.png`, `site/apple-touch-icon.png` and `site/favicon.ico` from `site/favicon.svg` in headless Chromium; `npm run social-images` draws one 1200 x 630 PNG per page into `site/social/` from `site-src/social/template.html`, with the page's share heading from the page map. Rerun them after changing the mark, the template or a heading; `npm run screenshots` redraws the product images after a popup, side panel or sandbox change. All three need Playwright's Chromium (`npm ci`, `npx playwright install chromium`, or `LOTSYNC_CHROME=<path to a Chrome>`).
