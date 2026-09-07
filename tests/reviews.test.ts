import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { ReviewDatabase } from '../src/lib/browser/db'
import { ReviewStore, blankPhoto } from '../src/lib/browser/store'

const db = new ReviewDatabase('remove-reviews-' + crypto.randomUUID())
const store = new ReviewStore(db)
beforeAll(() => db.open())
beforeEach(() =>
  db.transaction('rw', db.tables, () =>
    Promise.all(db.tables.map((t) => t.clear()))
  )
)
afterAll(() => db.delete())
async function seed() {
  const first: any = await store.command('imports/create', {
    query: 'WA',
    account: 'me'
  })
  const second: any = await store.command('imports/create', {
    query: 'WA',
    account: 'me'
  })
  await db.photos.put({
    ...blankPhoto('photo'),
    account: 'me',
    decision: 'keep',
    revision: 2
  })
  await db.memberships.bulkPut([
    { importId: first.id, photoId: 'photo' },
    { importId: second.id, photoId: 'photo' }
  ])
  await db.history.add({
    photoId: 'photo',
    previous: 'unreviewed',
    next: 'keep',
    revision: 2,
    undone: 0
  })
  await db.deletions.put({
    batch: 'pending-check',
    photoId: 'photo',
    state: 'uncertain',
    error: 'connection lost'
  })
  await db.folders.put({ id: 'folder', name: 'Backup', count: 1, indexedAt: 1 })
  await db.files.put({
    folderId: 'folder',
    path: 'photo.jpg',
    filename: 'photo.jpg',
    bytes: 123,
    mtime: 1
  })
  return { first: first.id, second: second.id }
}
it('removes only the chosen review and its memberships, preserving shared decisions and recovery records', async () => {
  const { first, second } = await seed()
  const preserved = db.tables.filter(
    (t) => !['imports', 'memberships'].includes(t.name)
  )
  const before = await Promise.all(preserved.map((t) => t.toArray()))
  await store.command('imports/remove', { id: first })
  expect(await db.imports.get(first)).toBeUndefined()
  expect(await db.imports.get(second)).toBeDefined()
  expect(await db.memberships.toArray()).toEqual([
    { importId: second, photoId: 'photo' }
  ])
  expect(await Promise.all(preserved.map((t) => t.toArray()))).toEqual(before)
})
it('can remove the final review without losing retained photo decisions or folder data', async () => {
  const { first, second } = await seed()
  await store.command('imports/remove', { id: first })
  await store.command('imports/remove', { id: second })
  expect(await db.imports.count()).toBe(0)
  expect(await db.memberships.count()).toBe(0)
  expect((await db.photos.get('photo'))?.decision).toBe('keep')
  expect(await db.files.count()).toBe(1)
  expect(await db.deletions.count()).toBe(1)
})
it('rejects in-flight import pages after removal instead of recreating the review', async () => {
  const { first } = await seed()
  await store.command('imports/remove', { id: first })
  await expect(
    store.command('imports/page', {
      id: first,
      account: 'me',
      expectedCursor: null,
      cursor: null,
      items: [{ mediaKey: 'new-photo', filename: 'new.jpg' }]
    })
  ).rejects.toThrow('Import account mismatch')
  expect(await db.photos.count()).toBe(1)
  expect(await db.memberships.where('importId').equals(first).count()).toBe(0)
})
it('rolls back the membership removal if the review cannot be removed', async () => {
  const { first } = await seed()
  const fail = () => {
    throw new Error('storage failure')
  }
  db.imports.hook('deleting', fail)
  try {
    await expect(
      store.command('imports/remove', { id: first })
    ).rejects.toThrow('storage failure')
    expect(await db.imports.get(first)).toBeDefined()
    expect(await db.memberships.where('importId').equals(first).count()).toBe(1)
  } finally {
    db.imports.hook('deleting').unsubscribe(fail)
  }
})
it('reports already removed reviews without altering other data', async () => {
  const { first, second } = await seed()
  await store.command('imports/remove', { id: first })
  await expect(store.command('imports/remove', { id: first })).rejects.toThrow(
    'already been removed'
  )
  expect(await db.imports.get(second)).toBeDefined()
})
