# Releasing a version

Every version ships the same way. A person writes the release notes, `npm run release` stamps the number and packs the two zips (the one for the store, and the pilot zip for testers, which offers no sign-in), and a person commits, tags and uploads. The script never commits, tags, pushes or uploads anything.

## The checklist, in order

1. **The CHANGELOG entry.** The changes since the last version wait under `## Unreleased` at the top of `CHANGELOG.md`. Rename that heading to the usual format, `## 0.6.0 (2026-10-12, <what the release is>)`, check its Added, Changed and Fixed lines, then put a new, empty `## Unreleased` above it for the changes that come after. For a new major or minor version, also change the README's first line to `# Lot Current (v0.6)`. These two files may stay uncommitted until step 4; everything else must be committed before step 2.
2. **`npm run release -- 0.6.0`** (or `-- patch`, `-- minor`, `-- major`). Run it with `--dry-run` first: it prints each line it would change and writes nothing. Keep the `--`: without it npm takes `--dry-run` as its own option, and the script then treats that as a dry run too. The script refuses, and writes nothing, when:
   - git shows an uncommitted change outside `CHANGELOG.md` and `README.md`;
   - the version is not greater than the current one, or `extension/manifest.json`, `package.json` and `package-lock.json` disagree about the current one;
   - `CHANGELOG.md` has no `## 0.6.0 (` heading, or a newer version sits above it, or `## Unreleased` is missing, below it or still holds entries (they ship in 0.6.0, so they belong under its heading);
   - the README's first line does not carry the new major and minor number.

   Then it writes the version into `extension/manifest.json`, `package.json` and both places in `package-lock.json`, runs `npm test`, `npm run pack` and `npm run pack -- --pilot`, and prints the next steps. If the tests or either pack fail, it puts the three files back as they were.

   **A build that names the account project.** When `extension/src/accountConfig.js` names a Supabase project (`npm run set-project` filled it in), the build shows the optional Account step in the first-run wizard and sign-in under Settings, and the printed steps say so. That sign-in works only once the project is set up, so hand such a build to no tester and upload it nowhere before `docs/production-setup.md` steps 3 to 5 are done and `npm run check-deploy` shows no FAIL. The config cannot simply be emptied for the meantime: the Supabase deploy workflow refuses a project the committed config does not name.

   **The pilot zip** is the build testers get meanwhile. `npm run pack -- --pilot`, which the release runs after `npm run pack`, writes `dist/lot-current-extension-0.6.0-pilot.zip`: the normal zip's files, byte for byte, except `src/accountConfig.js`, whose `url`, `anonKey` and `functionsUrl` are left empty in the zip only, with one comment line at its top saying so. The committed file is only read, never changed. That copy has no Account step in set-up and one line under **Settings**, **Account** ("Accounts are not set up yet") instead of a sign-in; it syncs nothing and sends nothing to the account server. Before it writes anything, the pack loads the emptied file as a module and refuses, with the reason, when it would not turn accounts off or when the committed file no longer has the shape it rewrites (`scripts/pilot-config.mjs`; change that file and `test/pilotPack.test.js` with it). The release packs it itself, rather than printing the command, so the testers' zip comes from the same files in the same run as the store zip and a release never ends with only a zip that offers sign-in. `npm run store-check` checks the pilot zip whenever it is in `dist/`. The store never gets it.
3. **The end-to-end flows and the sandbox drive**: `npm run test:e2e`, then `npm run test:demo`, with Playwright's Chromium (README, "For development"). Then set-up on the pilot zip: `npm run test:e2e:wizard -- --zip dist/lot-current-extension-0.6.0-pilot.zip` runs the wizard flow on that zip's own files and checks there is no Account step and no sign-in under Settings. All must pass before the commit. CI runs the flows and the drive again after the push, and packs and checks both zips.
4. **Commit and tag**, as the script prints them:

   ```
   git add CHANGELOG.md README.md extension/manifest.json package.json package-lock.json
   git commit -m "Release 0.6.0"
   git tag -a v0.6.0 -m "Lot Current 0.6.0"
   git push --follow-tags
   ```

5. **Upload the zip.** In the Chrome Web Store Developer Dashboard: Lot Current, Package, Upload new package, choose `dist/lot-current-extension-0.6.0.zip` (the normal zip, never the `-pilot` one), then Submit for review. Upload the zip the script packed from the tagged files, not one rebuilt later. The first submission also needs every box in `store/listing.md`, "Before submitting", ticked.
6. **Unlisted first.** Visibility is Unlisted for the pilot and the design partners. It goes Public only after the review passes and the owner says so. Check the visibility on the Distribution page before submitting an update.
7. **Testers** get `dist/lot-current-extension-0.6.0-pilot.zip` until `docs/production-setup.md` steps 3 to 5 are done and `npm run check-deploy` shows no FAIL, and for as long as `PILOT.md` keeps the pilot signed out ("No sign-in while the texts are drafts"). After that they get the same file as the store. Both are the same extension, so either can be unzipped over the other in the same folder; the README's "Update" section says how to replace the files and reload.

## What to watch after

- **The review.** The dashboard shows its status and the developer account's email gets the result. A rejection names the policy: log it in the support log (`docs/support.md`), fix it in a new version, and submit that.
- **The rollout.** Chrome checks for updates every few hours, so store installs usually move to the new version within a day. The version is the first line of Settings in the popup, so every report says which build it came from.
- **The first reports.** Read the support inbox and log (`docs/support.md`) closely for the first days, **blocks posting** first.
- **Fields that could not be filled.** Each salesperson's Numbers tab lists them per field. They stay in that browser and are not synced, so the manager view does not show them: after a release, ask each person for **Copy summary** (or **Download CSV**) from their Numbers tab. A field that starts failing after a release points at the release or at a change in Facebook's form.
- **CI on the pushed commit**: the unit tests, the e2e flows, the sandbox drive and the pack job green.
- **A bad release is fixed forward.** The Web Store only takes a version greater than the one it has, so going back means a new patch version (`npm run release -- patch`) that carries the earlier code, with a CHANGELOG entry that says so.
