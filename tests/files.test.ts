import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  scanDirectory,
  readPhotoFile,
  safeRelativePath,
  folderPermission,
  indexFolderHandle
} from '../src/lib/browser/files'
import { ReviewDatabase } from '../src/lib/browser/db'
import { blankPhoto } from '../src/lib/browser/store'
function image(name: string, body = 'abc') {
  return {
    kind: 'file',
    name,
    getFile: vi.fn(async () => new File([body], name, { lastModified: 123 }))
  }
}
function directory(name: string, entries: any[]): any {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const entry of entries) yield [entry.name, entry]
    }
  }
}
afterEach(() => vi.restoreAllMocks())
describe('read-only folder handling', () => {
  it('indexes relative paths recursively, skipping hidden files and videos', async () => {
    const a = image('IMG-WA.jpg'),
      b = image('other.png'),
      hidden = image('.hidden.jpg')
    const handle = directory('Photos', [
      a,
      directory('Sent', [b]),
      hidden,
      image('video.mp4')
    ])
    expect(await scanDirectory(handle, 'folder')).toEqual([
      {
        folderId: 'folder',
        path: 'IMG-WA.jpg',
        filename: 'IMG-WA.jpg',
        bytes: 3,
        mtime: 123
      },
      {
        folderId: 'folder',
        path: 'Sent/other.png',
        filename: 'other.png',
        bytes: 3,
        mtime: 123
      }
    ])
    expect(hidden.getFile).not.toHaveBeenCalled()
  })
  it('can cancel a scan before any file is read', async () => {
    const controller = new AbortController()
    controller.abort()
    const file = image('a.jpg')
    await expect(
      scanDirectory(
        directory('Photos', [file]),
        'folder',
        () => {},
        controller.signal
      )
    ).rejects.toThrow()
    expect(file.getFile).not.toHaveBeenCalled()
  })
  it('rejects paths that could escape the chosen folder', () => {
    for (const path of [
      '/a.jpg',
      '../a.jpg',
      'Sent/../../a.jpg',
      'Sent//a.jpg',
      'Sent\\a.jpg',
      ''
    ])
      expect(safeRelativePath(path)).toBe(false)
    expect(safeRelativePath('Sent/a.jpg')).toBe(true)
  })
  it('does not prompt or read when permission is missing', async () => {
    const handle = {
      queryPermission: vi.fn(async () => 'denied'),
      getFileHandle: vi.fn(),
      requestPermission: vi.fn()
    }
    const database = {
      folders: { get: vi.fn(async () => ({ handle })) }
    } as unknown as ReviewDatabase
    const photo = {
      ...blankPhoto('a'),
      source: 'local' as const,
      folderId: 'folder',
      localPath: 'a.jpg'
    }
    await expect(readPhotoFile(photo, database)).rejects.toThrow(
      'Allow folder access'
    )
    expect(handle.getFileHandle).not.toHaveBeenCalled()
    expect(handle.requestPermission).not.toHaveBeenCalled()
    expect(await folderPermission(undefined)).toBe('missing')
  })
  it('opens a selected file with no write/create access and detects replacements', async () => {
    const file = image('a.jpg')
    const nested = { getFileHandle: vi.fn(async () => file) }
    const handle = {
      queryPermission: vi.fn(async () => 'granted'),
      getDirectoryHandle: vi.fn(async () => nested)
    }
    const database = {
      folders: { get: vi.fn(async () => ({ handle })) }
    } as unknown as ReviewDatabase
    const photo = {
      ...blankPhoto('a'),
      source: 'local' as const,
      folderId: 'folder',
      localPath: 'Sent/a.jpg',
      bytes: 3,
      localModified: 123
    }
    expect((await readPhotoFile(photo, database)).name).toBe('a.jpg')
    expect(handle.getDirectoryHandle).toHaveBeenCalledExactlyOnceWith('Sent')
    expect(nested.getFileHandle).toHaveBeenCalledExactlyOnceWith('a.jpg')
    await expect(
      readPhotoFile({ ...photo, bytes: 999 }, database)
    ).rejects.toThrow('has changed')
  })
  it('preserves the previous index when saving the new index fails', async () => {
    const db = new ReviewDatabase('folder-test-' + crypto.randomUUID())
    try {
      await db.folders.put({
        id: 'old',
        name: 'Photos',
        indexedAt: 1,
        count: 1
      })
      await db.files.put({
        folderId: 'old',
        path: 'old.jpg',
        filename: 'old.jpg',
        bytes: 3,
        mtime: 123
      })
      await db.settings.put({ key: 'activeFolder', value: 'old' })
      vi.spyOn(db.files, 'bulkPut').mockRejectedValueOnce(
        new DOMException('Storage full', 'QuotaExceededError')
      )
      await expect(
        indexFolderHandle(
          directory('Photos', [image('new.jpg')]),
          () => {},
          undefined,
          'old',
          db
        )
      ).rejects.toThrow('Storage full')
      expect((await db.files.toArray()).map((f) => f.path)).toEqual(['old.jpg'])
      expect(await db.setting('activeFolder', '')).toBe('old')
    } finally {
      await db.delete()
    }
  })
})
