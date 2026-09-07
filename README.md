# Photos Sifter

A browser-only photo review app built with SvelteKit, Tailwind CSS and shadcn-svelte. Review one image at a time, save keep/delete/unsure decisions, and confirm a preview before moving selected Google photos to trash.

Reviews are stored in **IndexedDB through Dexie**. Local photos are read through the **File System Access API**, using a folder you select. There is no application server, SQLite runtime, image upload service or hosted database.

## Run locally

Use Node 22.13 or newer and pnpm for development and building. The published app does not need Node.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5178** in Chrome. The development server serves the app; all review data and operations run in the browser.

## Build for bertspaan.nl/photos-sifter

```sh
pnpm build:pages
```

This sets `BASE_PATH=/photos-sifter` and generates static files in `build/`. Serve those files at **https://bertspaan.nl/photos-sifter/**. The output includes `index.html`, a `404.html` fallback, and `.nojekyll`; it contains no photo library or database. A plain `pnpm build` instead builds for the root path, useful for local static hosting.

The existing GitHub Actions workflow builds with the same base path, checks types and tests, and verifies that GitHub Pages reports exactly `https://bertspaan.nl/photos-sifter` before publishing. It runs on pushes to `main` or manual dispatch. This refactor does not itself publish the site.

For a GitHub Pages project site at that address, the repository normally needs to be named `photos-sifter`, inheriting `bertspaan.nl` from the account’s main Pages site. Leave the project’s custom-domain field empty; setting it to `bertspaan.nl` would target the domain root. See [GitHub’s custom-domain documentation](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages).

You can also host the `build/` contents under `/photos-sifter/` in an existing static website. The Chrome companion is deliberately restricted to this published address and localhost port 5178; changing the URL requires updating its allowlist and manifest.

## Choose the WhatsApp folder

1. Open **Setup** and click **Choose folder**.
2. Select `/Users/bertspaan/Pictures/WhatsApp/WhatsApp Images` in the native folder picker.
3. Allow **read** access. Indexing includes subfolders and shows a progress count.

The app stores the directory handle and filename index in IndexedDB. It reads original files only when showing local previews; photos are not copied into the database or uploaded. The original files cannot be written to, moved or deleted by this app. Cancelling a scan or failing to save it leaves the previous index intact.

After restarting the browser, access may need to be granted again using **Reconnect folder**. Restored workspaces retain folder metadata but cannot transfer permission grants; select the corresponding original folder again. A local file whose size or modification time changed is not silently substituted into an old review. Reindex and start a local review to review changed files again.

Use Chrome or Edge for the folder picker. Google Photos currently connects through the Chrome companion. Unsupported folder-picker browsers show a message instead of attempting server access. Local previews use the browser’s supported image formats; HEIC support varies, and unsupported images show an error. Videos are skipped.

References: [MDN File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API), [directory picker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), [Dexie](https://dexie.org/docs/Tutorial/Getting-started).

## Connect Google Photos

1. In the app’s **Setup → Chrome companion** panel, click **Download Chrome extension**. The same button is in the installation help.
2. Unzip the download and keep the extracted `photos-sifter-extension` folder on your computer.
3. Open `chrome://extensions` in Chrome and enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted folder containing `manifest.json`.
5. Open Google Photos in the same Chrome profile and sign in. Keep that tab open.
6. Reload Photo Review, choose **Setup → Connect**, check the account, and start an import.

Visitors do not need Node, a local server or the project source. Developers can also load this project’s `extension` folder directly. To update an installed copy, replace its files using a fresh download, reload the extension in Chrome’s extensions page, then reload the app.

`pnpm dev` and `pnpm build` automatically package the current extension into `static/downloads/photos-sifter-extension.zip`. Run `pnpm package:extension` to refresh the download while the development server is already running. The ZIP contains the extension’s runtime files, installation instructions and third-party attribution. The generated ZIP is ignored by Git and copied into the static site during builds; its download link respects `/photos-sifter`.

The companion runs requests inside the signed-in Google Photos tab. Credentials remain in that tab; the app receives sanitized photo metadata and bounded preview image bytes. The companion resolves each preview by photo ID in the matching account and loads it inside Google Photos, so protected previews also work on the published app. The app displays local blob URLs and keeps at most 32 previews / 24 MiB in a temporary memory cache, with up to three requests at once. Image bytes are never saved to IndexedDB. This requires companion version 0.2.2 or later; after replacing its files, reload the extension and the app. The extension accepts app requests only from the configured local origin or published path, in the top-level frame. It has no wildcard permission to connect arbitrary HTTPS websites.

Google’s supported Library API does not permit scanning an existing personal library. This companion uses **undocumented Google Photos website endpoints**, which can change; it is not an OAuth app. Mock-response tests cover the protocol and failure handling, but do not prove compatibility with the live service. Live Google deletion was not tested and no Google photos were deleted during development.

References: [Google API changes](https://developers.google.com/photos/support/updates), [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) (MIT protocol reference; see `THIRD_PARTY_NOTICES.md`).

## Choose a review

- **Google Photos search:** enter a query such as `"WA"`; Google search can include false positives.
- **All Google Photos:** imports the library, including archived photos.
- **Local folder:** review originals without the extension. Local decisions are separate from cloud decisions and are not automatically transferred by filename.

Apply either or both filters to a Google import:

- **Match local filenames:** include only cloud photos with an exact filename in the indexed folder.
- **Filename list:** paste one exact filename per line, upload `.txt`, or use a JSON array such as `["IMG-20260713-WA0019.jpg"]`.

A filename match is a candidate filter, not proof that image bytes are identical. Google photos always use Google’s own preview. Files with no match stay outside the filtered queue and receive no decision. Clear both filters to review everything in that import. The deletion selection follows the current filters.

Imports save page by page and can be paused and resumed. The counter measures imported photos so far; a paused import is not a complete library count. No face recognition is performed.

## Review controls

| Key                 | Action                           |
| ------------------- | -------------------------------- |
| K / Y / right arrow | Keep                             |
| D / N / left arrow  | Mark for deletion                |
| Space               | Unsure                           |
| Z                   | Undo the last remaining decision |

The same actions have mouse buttons. Previous/next controls navigate without deciding. Shortcuts are disabled while typing or using a modal. Each decision is saved in an IndexedDB transaction before advancing. Reimporting a Google photo in the same account preserves its decision. Conflicting writes from another tab are rejected; return focus to the app to refresh its state.

## Delete only after a preview

1. **Mark for deletion** records a decision in the browser.
2. **Delete … photos** opens a modal showing the exact selection and account, in batches of up to 100 marked photos from the current filtered review.
3. Wait for every selected preview to load, inspect the images, and click **Delete … photos** again.

Confirmations expire after 15 minutes and are bound to photo identities and decision revisions. Changed decisions need a fresh preview. Before moving an image to trash, the companion checks its Google ID, deletion key and filename. Only owned Google photos marked for deletion qualify; local originals cannot be deleted.

The companion checks the photo’s trash status after each operation. It never permanently deletes or empties trash. Google deletion may propagate to synced devices; the separately copied WhatsApp backup remains unchanged.

If a request fails or a tab closes mid-operation, the batch stops. Uncertain attempts are locked until you reconnect the same account and choose **Check status**. No deletion mutation is retried automatically. Unattempted photos need a new preview and confirmation.

## Storage and moving to the published site

IndexedDB stores imports, filenames, decisions, undo history, folder handles and deletion status. Photo bytes are read on demand and temporary preview URLs are released when the image leaves the interface. A small local-storage entry remembers the current review and filters.

Browser storage belongs to the **origin and browser profile**. `localhost`, `127.0.0.1` and `bertspaan.nl` have separate workspaces. Other paths on the same origin share the browser’s security boundary.

In **Setup**:

- **Keep data on this device** requests persistent storage. The browser may decline; clearing site data still removes it even when persistence is granted.
- **Export workspace** saves a JSON backup of reviews, decisions, folder metadata and deletion status. It includes neither original photos nor folder permissions or reusable confirmation tokens.
- **Restore workspace** restores that backup into an **empty** workspace, such as the newly published website. It refuses to overwrite existing reviews. Interrupted deletions remain locked for verification after restoring.

To move from localhost: export the workspace, open the published website, restore the JSON file in Setup, then reconnect local folders. Keep a workspace export as a backup. Clearing browser data otherwise loses review progress.

**Export decisions** is a smaller report of the current import’s choices and Google links. It is not a restorable workspace backup; already-trashed items are omitted from that report.

The previous `.data/review.sqlite` and its index were left untouched and are ignored by Git, but the browser app does not read them. There were no saved photo decisions in that database when this refactor started. Choose the folder again to create the browser’s filename index.

## Development checks

```sh
pnpm check
pnpm test
pnpm build:pages
pnpm format:check
```

Tests use fake IndexedDB, mocked file handles and mock Google responses. They cover database reopening, competing tabs, exact filenames, stale confirmations, interrupted deletions, cancelled scans, read-only access, quota failures, workspace restoration and the extension’s exact URL boundary. Native folder-picker UI and live Google deletion require separate manual verification.

## Remove old reviews

Use the × button beside a review in the sidebar, then confirm **Remove review**. This removes the review and its list membership from this browser. Photos, saved keep/delete decisions, undo history and deletion status remain available, including when another review contains the same photos or you import them again. Removing a review never contacts Google Photos or changes local files.
