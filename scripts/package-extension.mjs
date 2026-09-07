import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { APP_URL } from '../extension/app-url.js'

const root = new URL('../', import.meta.url)
const folder = 'photos-sifter-extension'
// Keep the downloadable package limited to the extension's runtime files.
const files = [
  'manifest.json',
  'background.js',
  'bridge.js',
  'google-client.js',
  'app-url.js',
  'popup.html'
]
const archive = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      `${folder}/${name}`,
      new Uint8Array(await readFile(new URL(`extension/${name}`, root)))
    ])
  )
)
const manifest = JSON.parse(
  new TextDecoder().decode(archive[`${folder}/manifest.json`])
)
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((script) => [
    ...(script.js || []),
    ...(script.css || [])
  ])
].filter(Boolean)
for (const name of referenced)
  if (!files.includes(name))
    throw new Error(`Add ${name} to the extension package before building.`)
archive[`${folder}/THIRD_PARTY_NOTICES.md`] = new Uint8Array(
  await readFile(new URL('THIRD_PARTY_NOTICES.md', root))
)
archive[`${folder}/INSTALL.txt`] =
  strToU8(`Photos Sifter Chrome companion — version ${manifest.version}

1. Unzip photos-sifter-extension.zip and keep the extracted folder.
2. In Chrome, open chrome://extensions and enable Developer mode.
3. Click Load unpacked and select the photos-sifter-extension folder containing manifest.json.
4. Open https://photos.google.com in the same Chrome profile and sign in.
5. Open ${APP_URL}, reload the page, and choose Setup → Connect.

No Node.js, local server, or project checkout is needed.
Keep the extracted folder while the extension is installed.
To update, replace its files with the new download, reload the extension in chrome://extensions, and reload the app.

The companion is configured for ${APP_URL} and localhost port 5178.
It uses your signed-in Google Photos tab; credentials remain in that tab.
Marking a photo does not delete it. Moving photos to trash requires the app's preview and a second confirmation.
`)
const output = new URL('static/downloads/photos-sifter-extension.zip', root)
await mkdir(new URL('./', output), { recursive: true })
const bytes = zipSync(archive, {
  level: 9,
  mtime: new Date('2020-01-01T00:00:00Z')
})
await writeFile(new URL(output.href + '.tmp'), bytes)
await rename(new URL(output.href + '.tmp'), output)
console.log(
  `Packaged Chrome companion ${manifest.version}: ${fileURLToPath(output)} (${bytes.length} bytes)`
)
