# Releasing a version

Every version ships the same way. A person writes the release notes, `npm run release` stamps the number and packs the zip, and a person commits, tags and uploads. The script never commits, tags, pushes or uploads anything.

## The checklist, in order

1. **The CHANGELOG entry.** At the top of `CHANGELOG.md`, above the last version, a heading in the usual format, `## 0.6.0 (2026-10-12, <what the release is>)`, then its Added, Changed and Fixed lines. For a new major or minor version, also change the README's first line to `# Lot Sync (v0.6)`. These two files may stay uncommitted until step 4; everything else must be committed before step 2.
2. **`npm run release -- 0.6.0`** (or `-- patch`, `-- minor`, `-- major`). Run it with `--dry-run` first: it prints each line it would change and writes nothing. Keep the `--`: without it npm takes `--dry-run` as its own option, and the script then treats that as a dry run too. The script refuses, and writes nothing, when:
   - git shows an uncommitted change outside `CHANGELOG.md` and `README.md`;
   - the version is not greater than the current one, or `extension/manifest.json`, `package.json` and `package-lock.json` disagree about the current one;
   - `CHANGELOG.md` has no `## 0.6.0 (` heading, or it is not the top one;
   - the README's first line does not carry the new major and minor number.

   Then it writes the version into `extension/manifest.json`, `package.json` and both places in `package-lock.json`, runs `npm test` and `npm run pack`, and prints the next steps. If the tests or the pack fail, it puts the three files back as they were.
3. **The end-to-end flows and the sandbox drive**: `npm run test:e2e`, then `npm run test:demo`, with Playwright's Chromium (README, "For development"). Both must pass before the commit. CI runs them again after the push.
4. **Commit and tag**, as the script prints them:

   ```
   git add CHANGELOG.md README.md extension/manifest.json package.json package-lock.json
   git commit -m "Release 0.6.0"
   git tag -a v0.6.0 -m "Lot Sync 0.6.0"
   git push --follow-tags
   ```

5. **Upload the zip.** In the Chrome Web Store Developer Dashboard: Lot Sync, Package, Upload new package, choose `dist/lot-sync-extension-0.6.0.zip`, then Submit for review. Upload the zip the script packed from the tagged files, not one rebuilt later. The first submission also needs every box in `store/listing.md`, "Before submitting", ticked.
6. **Unlisted first.** Visibility is Unlisted for the pilot and the design partners. It goes Public only after the review passes and the owner says so. Check the visibility on the Distribution page before submitting an update.
7. **Testers on the zip** get the same file. The README's "Update" section says how to replace the files and reload.

## What to watch after

- **The review.** The dashboard shows its status and the developer account's email gets the result. A rejection names the policy: log it in the support log (`docs/support.md`), fix it in a new version, and submit that.
- **The rollout.** Chrome checks for updates every few hours, so store installs usually move to the new version within a day. The version is the first line of Settings in the popup, so every report says which build it came from.
- **The first reports.** Read the support inbox and log (`docs/support.md`) closely for the first days, **blocks posting** first.
- **Fields that could not be filled.** The Numbers tab (or the manager view) lists them per field. A field that starts failing after a release points at the release or at a change in Facebook's form.
- **CI on the pushed commit**: the unit tests, the e2e flows, the sandbox drive and the pack job green.
- **A bad release is fixed forward.** The Web Store only takes a version greater than the one it has, so going back means a new patch version (`npm run release -- patch`) that carries the earlier code, with a CHANGELOG entry that says so.
