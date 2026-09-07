import { z } from 'zod'
import { db, type ReviewDatabase } from './db'
import { idSchema, decisionSchema, validateThumbnail } from './store'
import { safeRelativePath } from './files'
const pathSchema = z
  .string()
  .refine(safeRelativePath, 'Invalid relative photo path.')
const photoSchema = z.object({
  id: idSchema,
  account: z.string(),
  mediaKey: z.string(),
  dedupKey: z.string(),
  filename: z.string().min(1),
  thumb: z.string(),
  timestamp: z.number(),
  width: z.number(),
  height: z.number(),
  bytes: z.number().nonnegative(),
  localPath: z.string(),
  localMatches: z.number(),
  decision: decisionSchema,
  revision: z.number().int().nonnegative(),
  trashed: z.union([z.literal(0), z.literal(1)]),
  source: z.enum(['google', 'local']),
  importId: z.string(),
  isOwned: z.boolean(),
  folderId: z.string().optional(),
  localModified: z.number().optional()
})
const jobSchema = z.object({
  id: idSchema,
  source: z.enum(['local', 'google']),
  query: z.string(),
  account: z.string(),
  cursor: z.string().nullable(),
  status: z.enum(['paused', 'complete']),
  count: z.number().int().nonnegative(),
  error: z.string(),
  created: z.number()
})
const backupSchema = z.object({
  format: z.literal('clean-google-photos'),
  version: z.literal(1),
  exportedAt: z.string(),
  activeFolder: z.string(),
  folders: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      indexedAt: z.number(),
      count: z.number().int().nonnegative()
    })
  ),
  files: z.array(
    z.object({
      folderId: idSchema,
      path: pathSchema,
      filename: z.string(),
      bytes: z.number().nonnegative(),
      mtime: z.number()
    })
  ),
  photos: z.array(photoSchema),
  imports: z.array(jobSchema),
  memberships: z.array(z.object({ importId: idSchema, photoId: idSchema })),
  history: z.array(
    z.object({
      seq: z.number().int().positive().optional(),
      photoId: idSchema,
      previous: decisionSchema,
      next: decisionSchema,
      revision: z.number().int(),
      undone: z.union([z.literal(0), z.literal(1)])
    })
  ),
  deletions: z.array(
    z.object({
      batch: idSchema,
      photoId: idSchema,
      state: z.enum(['executing', 'uncertain', 'trashed', 'not-trashed']),
      error: z.string()
    })
  )
})
export async function exportWorkspace(database: ReviewDatabase = db) {
  return database.transaction('r', database.tables, async () => ({
    format: 'clean-google-photos',
    version: 1,
    exportedAt: new Date().toISOString(),
    activeFolder: await database.setting('activeFolder', ''),
    folders: (await database.folders.toArray()).map(
      ({ handle, ...metadata }) => metadata
    ),
    files: await database.files.toArray(),
    photos: await database.photos.toArray(),
    imports: await database.imports.toArray(),
    memberships: await database.memberships.toArray(),
    history: await database.history.toArray(),
    deletions: (await database.deletions.toArray()).filter(
      (d) => d.state !== 'pending'
    )
  }))
}
export async function restoreWorkspace(
  input: unknown,
  database: ReviewDatabase = db
) {
  const data = backupSchema.parse(input)
  const photos = new Map(data.photos.map((p) => [p.id, p]))
  const folders = new Set(data.folders.map((f) => f.id)),
    jobs = new Set(data.imports.map((j) => j.id))
  if (
    photos.size !== data.photos.length ||
    folders.size !== data.folders.length ||
    jobs.size !== data.imports.length
  )
    throw new Error('Backup contains duplicate IDs.')
  for (const p of data.photos) {
    validateThumbnail(p.thumb)
    if (
      p.source === 'local' &&
      (!p.folderId ||
        !folders.has(p.folderId) ||
        !safeRelativePath(p.localPath))
    )
      throw new Error('Backup has an invalid folder reference.')
  }
  for (const f of data.files)
    if (!folders.has(f.folderId))
      throw new Error('Backup has an invalid folder reference.')
  if (data.activeFolder && !folders.has(data.activeFolder))
    throw new Error('Backup has an invalid active folder.')
  for (const link of data.memberships)
    if (!jobs.has(link.importId) || !photos.has(link.photoId))
      throw new Error('Backup has an invalid review reference.')
  for (const row of [...data.history, ...data.deletions])
    if (!photos.has(row.photoId))
      throw new Error('Backup has an invalid photo reference.')
  // Unresolved operations remain locked. A backup can never carry a usable confirmation token.
  const deletions = data.deletions.map((d) => ({
    ...d,
    state: d.state === 'executing' ? ('uncertain' as const) : d.state
  }))
  for (const d of deletions)
    if (d.state === 'uncertain') {
      const p = photos.get(d.photoId)!
      p.trashed = 0
    }
  await database.transaction('rw', database.tables, async () => {
    if (
      (await database.photos.count()) ||
      (await database.imports.count()) ||
      (await database.folders.count())
    )
      throw new Error(
        'Restore into an empty workspace, such as the new website. Existing reviews will not be overwritten.'
      )
    await database.folders.bulkAdd(data.folders)
    await database.files.bulkAdd(data.files)
    await database.photos.bulkAdd([...photos.values()])
    await database.imports.bulkAdd(data.imports)
    await database.memberships.bulkAdd(data.memberships)
    await database.history.bulkAdd(data.history)
    await database.deletions.bulkAdd(deletions)
    await database.settings.put({
      key: 'activeFolder',
      value: data.activeFolder
    })
  })
  return { photos: data.photos.length, imports: data.imports.length }
}
export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
