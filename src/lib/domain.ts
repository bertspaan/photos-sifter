import type { Photo, Filters } from './types'
export function parseFilenames(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  let values: unknown = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed.split(/\r?\n/)
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string'))
    throw new Error('Use one filename per line or a JSON array of strings.')
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))]
}
export function matchesFilters(p: Photo, f: Filters): boolean {
  return (
    (!f.importId || p.importId === f.importId) &&
    (!f.decision || f.decision === 'all' || p.decision === f.decision) &&
    (!f.matchOnly || p.localMatches > 0) &&
    (!f.filenames.length || f.filenames.includes(p.filename))
  )
}
export function validateDeletion(rows: Photo[]): void {
  if (!rows.length) throw new Error('No photos are selected for deletion.')
  if (rows.length > 500) throw new Error('Delete up to 500 photos at a time.')
  if (new Set(rows.map((p) => p.account)).size !== 1)
    throw new Error('Review one Google account at a time.')
  if (new Set(rows.map((p) => p.dedupKey)).size !== rows.length)
    throw new Error(
      'Selected photos share a deletion key. Nothing was deleted.'
    )
  for (const p of rows)
    if (
      p.source !== 'google' ||
      p.decision !== 'delete' ||
      p.trashed ||
      !p.mediaKey ||
      !p.dedupKey ||
      !p.filename ||
      !p.isOwned
    )
      throw new Error(
        'Only owned Google Photos marked for deletion can be moved to trash.'
      )
}
export function previewFingerprint(rows: Photo[]): string {
  return JSON.stringify(
    rows
      .map((p) => [
        p.id,
        p.revision,
        p.decision,
        p.dedupKey,
        p.account,
        p.mediaKey,
        p.filename,
        p.source,
        p.isOwned,
        p.thumb
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  )
}
