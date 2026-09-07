import { beforeEach, afterEach, it, expect } from 'vitest'
import { ReviewDatabase } from '../src/lib/browser/db'
import { ReviewStore, blankPhoto } from '../src/lib/browser/store'
import { exportWorkspace, restoreWorkspace } from '../src/lib/browser/backup'
let source: ReviewDatabase, target: ReviewDatabase
beforeEach(async () => {
  source = new ReviewDatabase('backup-source-' + crypto.randomUUID())
  target = new ReviewDatabase('backup-target-' + crypto.randomUUID())
  await source.photos.put({
    ...blankPhoto('a'),
    account: 'me',
    filename: 'photo.jpg',
    mediaKey: 'key',
    dedupKey: 'dedup',
    decision: 'delete',
    isOwned: true
  })
  await source.imports.put({
    id: 'j',
    source: 'google',
    query: 'WA',
    account: 'me',
    cursor: null,
    status: 'complete',
    count: 1,
    error: '',
    created: 1
  })
  await source.memberships.put({ importId: 'j', photoId: 'a' })
})
afterEach(async () => {
  await source.delete()
  await target.delete()
})
it('restores photos, reviews and decisions on a new origin', async () => {
  const backup = JSON.parse(JSON.stringify(await exportWorkspace(source)))
  await restoreWorkspace(backup, target)
  const review = new ReviewStore(target)
  expect((await review.getPhoto('a')).decision).toBe('delete')
  expect((await review.state()).imports[0].count).toBe(1)
})
it('does not export folder capabilities or confirmation tokens', async () => {
  await source.folders.put({ id: 'f', name: 'Photos', count: 0, indexedAt: 1 })
  await source.previews.put({
    token: 'secret',
    ids: ['a'],
    fingerprint: 'fixture',
    consumed: true,
    expires: Date.now() + 1000
  })
  await source.deletions.put({
    batch: 'secret',
    photoId: 'a',
    state: 'pending',
    error: ''
  })
  const backup = await exportWorkspace(source)
  expect(backup.folders[0]).not.toHaveProperty('handle')
  expect(backup).not.toHaveProperty('previews')
  expect(backup.deletions).toHaveLength(0)
  await restoreWorkspace(backup, target)
  await expect(
    new ReviewStore(target).command('delete-confirm', { token: 'secret' })
  ).rejects.toThrow('expired')
})
it('keeps interrupted deletions locked after restoring', async () => {
  await source.deletions.put({
    batch: 'b',
    photoId: 'a',
    state: 'executing',
    error: ''
  })
  await restoreWorkspace(await exportWorkspace(source), target)
  expect((await target.deletions.get(['b', 'a']))?.state).toBe('uncertain')
  await expect(
    new ReviewStore(target).command('decision', {
      id: 'a',
      decision: 'keep',
      revision: 0
    })
  ).rejects.toThrow('Verify')
})
it('refuses to overwrite an existing workspace', async () => {
  await target.photos.put({
    ...blankPhoto('existing'),
    filename: 'existing.jpg'
  })
  await expect(
    restoreWorkspace(await exportWorkspace(source), target)
  ).rejects.toThrow('empty workspace')
  expect((await target.photos.toArray()).map((p) => p.id)).toEqual(['existing'])
})
it('rejects unsafe preview URLs before restoring anything', async () => {
  const backup = await exportWorkspace(source)
  backup.photos[0].thumb = 'https://other.example/image.jpg'
  await expect(restoreWorkspace(backup, target)).rejects.toThrow(
    'Unexpected image host'
  )
  expect(await target.photos.count()).toBe(0)
})
