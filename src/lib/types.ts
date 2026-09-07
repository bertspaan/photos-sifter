export type Decision = 'unreviewed' | 'keep' | 'delete' | 'unsure'
export type Photo = {
  folderId?: string
  localModified?: number
  id: string
  account: string
  mediaKey: string
  dedupKey: string
  filename: string
  thumb: string
  timestamp: number
  width: number
  height: number
  bytes: number
  localPath: string
  localMatches: number
  decision: Decision
  revision: number
  trashed: number
  source: 'google' | 'local'
  importId: string
  isOwned: boolean
}
export type ImportJob = {
  id: string
  source: 'local' | 'google'
  query: string
  account: string
  cursor: string | null
  status: string
  count: number
  error: string
  created: number
}
export type AppState = {
  folderId?: string
  imports: ImportJob[]
  localCount: number
  root: string
  undoCount: number
}
export type Filters = {
  importId: string
  decision: string
  matchOnly: boolean
  filenames: string[]
}
