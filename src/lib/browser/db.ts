import Dexie, { type Table } from 'dexie'
import type { Photo, ImportJob } from '../types'
export type FolderRecord = {
  id: string
  name: string
  handle?: FileSystemDirectoryHandle
  indexedAt: number
  count: number
}
export type LocalFile = {
  folderId: string
  path: string
  filename: string
  bytes: number
  mtime: number
}
export type History = {
  seq?: number
  photoId: string
  previous: Photo['decision']
  next: Photo['decision']
  revision: number
  undone: number
}
export type Preview = {
  token: string
  ids: string[]
  fingerprint: string
  expires: number
  consumed: boolean
}
export type DeletionItem = {
  batch: string
  photoId: string
  state: 'pending' | 'executing' | 'uncertain' | 'trashed' | 'not-trashed'
  error: string
}
export class ReviewDatabase extends Dexie {
  settings!: Table<{ key: string; value: unknown }, string>
  imports!: Table<ImportJob, string>
  photos!: Table<Photo, string>
  memberships!: Table<{ importId: string; photoId: string }, [string, string]>
  folders!: Table<FolderRecord, string>
  files!: Table<LocalFile, [string, string]>
  history!: Table<History, number>
  previews!: Table<Preview, string>
  deletions!: Table<DeletionItem, [string, string]>
  constructor(name = 'clean-google-photos-v1') {
    super(name, { chromeTransactionDurability: 'strict' })
    this.version(1).stores({
      settings: 'key',
      imports: 'id,created',
      photos: 'id,decision,trashed,[account+dedupKey]',
      memberships: '[importId+photoId],importId,photoId',
      folders: 'id',
      files: '[folderId+path],folderId,[folderId+filename]',
      history: '++seq,photoId,undone',
      previews: 'token',
      deletions: '[batch+photoId],photoId,state'
    })
  }
  async setting<T>(key: string, fallback: T): Promise<T> {
    return ((await this.settings.get(key))?.value as T) ?? fallback
  }
}
export const db = new ReviewDatabase()
