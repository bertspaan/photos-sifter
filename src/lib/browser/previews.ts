import { bridge } from '../bridge'
import type { Photo } from '../types'

type Connection = { tabId: number; account: string }
type Reply = { account: string; mediaKey: string; mime: string; base64: string }
type Request = (action: string, payload?: unknown) => Promise<any>
const MAX_BYTES = 8 * 1024 * 1024
const CACHE_BYTES = 24 * 1024 * 1024
const MAX_ENTRIES = 32
const TTL = 5 * 60 * 1000

// Memory only: no image bytes, login details, or object URLs go into IndexedDB.
export class PreviewLoader {
  private cache = new Map<string, { blob: Blob; expires: number }>()
  private pending = new Map<string, Promise<Blob>>()
  private bytes = 0
  private active = 0
  private waiting: (() => void)[] = []
  private discovery?: Promise<Connection[]>
  private discoveredAt = 0

  constructor(private request: Request = bridge) {}

  private async connections() {
    if (!this.discovery || Date.now() - this.discoveredAt > 10000) {
      this.discoveredAt = Date.now()
      this.discovery = this.request('ping')
        .then((result) => {
          if (!result.capabilities?.includes('preview'))
            throw new Error(
              'Update the Chrome companion to version 0.2.2 or later, reload it in chrome://extensions, and reload this app.'
            )
          return result.tabs as Connection[]
        })
        .catch((error) => {
          this.discovery = undefined
          throw error
        })
    }
    return this.discovery
  }

  private async fetch(photo: Photo, size: 320 | 1600) {
    const connection = (await this.connections()).find(
      (c) => c.account === photo.account
    )
    if (!connection)
      throw new Error(
        'Open Google Photos signed in to the account for this photo, then refresh the preview.'
      )
    const result: Reply = await this.request('preview', {
      ...connection,
      mediaKey: photo.mediaKey,
      size
    })
    if (result.account !== photo.account || result.mediaKey !== photo.mediaKey)
      throw new Error('The preview belongs to a different photo or account.')
    if (
      ![
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/avif',
        'image/gif'
      ].includes(result.mime) ||
      typeof result.base64 !== 'string' ||
      !result.base64 ||
      result.base64.length > Math.ceil(MAX_BYTES / 3) * 4
    )
      throw new Error('The companion returned an invalid preview.')
    const binary = atob(result.base64)
    if (!binary.length || binary.length > MAX_BYTES)
      throw new Error('The companion returned an invalid preview.')
    return new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))], {
      type: result.mime
    })
  }

  load(photo: Photo, size: 320 | 1600): Promise<Blob> {
    // A refreshed URL invalidates cached bytes, while account and identity isolate images.
    const key = JSON.stringify([
      photo.account,
      photo.mediaKey,
      photo.thumb,
      size
    ])
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      if (cached.expires > Date.now()) {
        this.cache.set(key, cached)
        return Promise.resolve(cached.blob)
      }
      this.bytes -= cached.blob.size
    }
    const pending = this.pending.get(key)
    if (pending) return pending
    const result = this.schedule(async () => {
      const blob = await this.fetch(photo, size)
      this.cache.set(key, { blob, expires: Date.now() + TTL })
      this.bytes += blob.size
      while (this.bytes > CACHE_BYTES || this.cache.size > MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value!
        this.bytes -= this.cache.get(oldest)!.blob.size
        this.cache.delete(oldest)
      }
      return blob
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, result)
    return result
  }

  private async schedule<T>(work: () => Promise<T>) {
    if (this.active >= 3)
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active++
    try {
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}
export const previews = new PreviewLoader()
