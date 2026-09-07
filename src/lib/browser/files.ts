import {
  db,
  type ReviewDatabase,
  type LocalFile,
  type FolderRecord
} from './db'
import type { Photo } from '../types'
export function supportsFolderPicker() {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function'
  )
}
export function safeRelativePath(path: string) {
  return (
    !!path &&
    !path.startsWith('/') &&
    path
      .split('/')
      .every(
        (part) =>
          part !== '' && part !== '.' && part !== '..' && !part.includes('\\')
      )
  )
}
export async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  folderId: string,
  onProgress: (count: number) => void = () => {},
  signal?: AbortSignal
): Promise<LocalFile[]> {
  const files: LocalFile[] = []
  async function walk(directory: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, entry] of directory.entries()) {
      signal?.throwIfAborted()
      if (name.startsWith('.')) continue
      const path = prefix + name
      if (!safeRelativePath(path))
        throw new Error('The folder contains an unsupported filename.')
      if (entry.kind === 'directory')
        await walk(entry as FileSystemDirectoryHandle, path + '/')
      else if (/\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(name)) {
        const file = await (entry as FileSystemFileHandle).getFile()
        files.push({
          folderId,
          path,
          filename: name,
          bytes: file.size,
          mtime: file.lastModified
        })
        if (files.length % 100 === 0) onProgress(files.length)
      }
    }
  }
  await walk(handle, '')
  signal?.throwIfAborted()
  onProgress(files.length)
  return files
}
export async function indexFolderHandle(
  handle: FileSystemDirectoryHandle,
  onProgress: (count: number) => void = () => {},
  signal?: AbortSignal,
  reattachId?: string,
  database: ReviewDatabase = db
) {
  let existing: FolderRecord | undefined
  const folders = await database.folders.toArray()
  if (reattachId) {
    existing = folders.find((f) => f.id === reattachId)
    if (!existing || existing.name !== handle.name)
      throw new Error(
        'Select the original folder named ' +
          (existing?.name || 'in this review') +
          '.'
      )
  } else
    for (const f of folders) {
      try {
        if (f.handle && (await handle.isSameEntry(f.handle))) {
          existing = f
          break
        }
      } catch {}
    }
  const id = existing?.id || crypto.randomUUID()
  const files = await scanDirectory(handle, id, onProgress, signal)
  const folder = {
    id,
    name: handle.name,
    handle,
    indexedAt: Date.now(),
    count: files.length
  }
  await database.transaction(
    'rw',
    database.folders,
    database.files,
    database.settings,
    async () => {
      await database.files.where('folderId').equals(id).delete()
      await database.files.bulkPut(files)
      await database.folders.put(folder)
      await database.settings.put({ key: 'activeFolder', value: id })
    }
  )
  return folder
}
export async function activeFolder(database: ReviewDatabase = db) {
  const id = await database.setting('activeFolder', '')
  return id ? database.folders.get(id) : undefined
}
export async function folderPermission(
  folder?: FolderRecord
): Promise<PermissionState | 'missing'> {
  if (!folder?.handle) return 'missing'
  try {
    return await folder.handle.queryPermission({ mode: 'read' })
  } catch {
    return 'missing'
  }
}
export async function readPhotoFile(
  photo: Photo,
  database: ReviewDatabase = db
): Promise<File> {
  if (
    photo.source !== 'local' ||
    !photo.folderId ||
    !safeRelativePath(photo.localPath)
  )
    throw new Error('No local file is linked to this photo.')
  const folder = await database.folders.get(photo.folderId)
  if (!folder?.handle)
    throw new Error('Reconnect this photo’s folder in Setup.')
  if ((await folder.handle.queryPermission({ mode: 'read' })) !== 'granted')
    throw new Error('Allow folder access again in Setup to view local photos.')
  const parts = photo.localPath.split('/')
  let directory = folder.handle
  for (const part of parts.slice(0, -1))
    directory = await directory.getDirectoryHandle(part)
  const file = await (await directory.getFileHandle(parts.at(-1)!)).getFile()
  if (
    file.size !== photo.bytes ||
    (photo.localModified && file.lastModified !== photo.localModified)
  )
    throw new Error(
      'This local file has changed. Reindex the folder and start a new review.'
    )
  return file
}
