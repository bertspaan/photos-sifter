import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { googleRequest } from '../extension/google-client.js'
import { PreviewLoader } from '../src/lib/browser/previews'
import { blankPhoto } from '../src/lib/browser/store'
const account = 'fixture@example.com'
const mediaKey = 'photo-a'
const bytes = new Uint8Array([137, 80, 78, 71])
const photo = { ...blankPhoto('a'), account, mediaKey, thumb: 'fixture' }

beforeEach(() => {
  vi.stubGlobal('window', {
    WIZ_global_data: {
      oPEP7c: account,
      SNlM0e: 'token',
      eptZe: '/_/PhotosUi/'
    }
  })
  vi.stubGlobal('location', {
    origin: 'https://photos.google.com',
    pathname: '/u/1/',
    href: 'https://photos.google.com/u/1/'
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function mockImage(
  options: {
    host?: string
    mime?: string
    status?: number
    length?: number
    key?: string
  } = {}
) {
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    if (init.method === 'POST') {
      const data = [
        [
          options.key || mediaKey,
          [
            options.host ||
              'https://photos.fife.usercontent.google.com/pw/fixture'
          ]
        ]
      ]
      return new Response(
        JSON.stringify([['wrb.fr', 'VrseUb', JSON.stringify(data)]])
      )
    }
    return new Response(bytes, {
      status: options.status || 200,
      headers: {
        'content-type': options.mime || 'image/png',
        ...(options.length ? { 'content-length': String(options.length) } : {})
      }
    })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const request = () => googleRequest('preview', { account, mediaKey, size: 320 })
describe('protected preview retrieval', () => {
  it('resolves fresh bytes in the selected account without exporting credentials', async () => {
    const fetcher = mockImage()
    const result = await request()
    expect(result).toEqual({
      account,
      mediaKey,
      mime: 'image/png',
      base64: 'iVBORw=='
    })
    expect(String(fetcher.mock.calls[1][0])).toBe(
      'https://photos.fife.usercontent.google.com/pw/fixture=w320-h320-no?authuser=1'
    )
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      credentials: 'include',
      redirect: 'error'
    })
    expect(JSON.stringify(result)).not.toContain('token')
  })
  it('does not fetch an unrelated host returned in metadata', async () => {
    const fetcher = mockImage({ host: 'https://evil.example/photo' })
    expect(await request()).toHaveProperty(
      'error',
      'Unexpected preview address.'
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects a changed account before any request', async () => {
    const fetcher = mockImage()
    expect(
      await googleRequest('preview', { account: 'other', mediaKey, size: 320 })
    ).toHaveProperty('error')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects a mismatched photo before fetching image bytes', async () => {
    const fetcher = mockImage({ key: 'different' })
    expect(await request()).toHaveProperty(
      'error',
      'Photo identity could not be verified.'
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    [{ mime: 'text/html' }, 'unsupported preview format'],
    [{ mime: 'image/svg+xml' }, 'unsupported preview format'],
    [{ status: 403 }, 'HTTP 403'],
    [{ length: 9 * 1024 * 1024 }, 'too large']
  ])(
    'rejects failed or invalid image responses: %j',
    async (options, error) => {
      mockImage(options)
      expect(((await request()) as any).error).toContain(error)
    }
  )
  it('bounds streamed responses even if content-length is absent', async () => {
    const fetcher = mockImage()
    fetcher.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify([
            [
              'wrb.fr',
              'VrseUb',
              JSON.stringify([
                [mediaKey, ['https://lh3.googleusercontent.com/fixture']]
              ])
            ]
          ])
        )
    )
    fetcher.mockImplementationOnce(
      async () =>
        new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'image/png' }
        })
    )
    expect(((await request()) as any).error).toContain('too large')
  })
})
function mockBridge() {
  return vi.fn(async (action: string, payload?: any) => {
    if (action === 'ping')
      return { capabilities: ['preview'], tabs: [{ account, tabId: 1 }] }
    return {
      account: payload.account,
      mediaKey: payload.mediaKey,
      mime: 'image/png',
      base64: 'iVBORw=='
    }
  })
}
describe('browser preview loading', () => {
  it('coalesces requests and caches image bytes without requesting Google URLs from the app', async () => {
    const bridge = mockBridge(),
      loader = new PreviewLoader(bridge)
    const [a, b] = await Promise.all([
      loader.load(photo, 320),
      loader.load(photo, 320)
    ])
    expect(a).toBe(b)
    expect(a.type).toBe('image/png')
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(bytes)
    expect(await loader.load(photo, 320)).toBe(a)
    expect(bridge.mock.calls.map((c) => c[0])).toEqual(['ping', 'preview'])
    expect(bridge.mock.calls[1][1]).toEqual({
      account,
      tabId: 1,
      mediaKey,
      size: 320
    })
  })
  it('tells users to reload an outdated companion', async () => {
    const loader = new PreviewLoader(async () => ({ tabs: [] }))
    await expect(loader.load(photo, 320)).rejects.toThrow('0.2.2')
  })
  it('refuses previews belonging to another account or photo', async () => {
    const bridge = mockBridge()
    const original = bridge.getMockImplementation()!
    bridge.mockImplementation(async (action, payload) =>
      action === 'ping'
        ? original(action, payload)
        : { account, mediaKey: 'other', mime: 'image/png', base64: 'iVBORw==' }
    )
    await expect(new PreviewLoader(bridge).load(photo, 320)).rejects.toThrow(
      'different photo or account'
    )
  })
  it('does not request a photo if its account is not open', async () => {
    const bridge = mockBridge()
    await expect(
      new PreviewLoader(bridge).load({ ...photo, account: 'other' }, 320)
    ).rejects.toThrow('account for this photo')
    expect(bridge).toHaveBeenCalledTimes(1)
  })
  it('does not cache failures, and separates sizes and refreshed addresses', async () => {
    const bridge = mockBridge(),
      loader = new PreviewLoader(bridge)
    const original = bridge.getMockImplementation()!
    let fail = true
    bridge.mockImplementation(async (action, payload) => {
      if (action === 'preview' && fail) {
        fail = false
        throw new Error('offline')
      }
      return original(action, payload)
    })
    await expect(loader.load(photo, 320)).rejects.toThrow('offline')
    await loader.load(photo, 320)
    await loader.load(photo, 1600)
    await loader.load({ ...photo, thumb: 'refreshed' }, 320)
    expect(bridge.mock.calls.filter((c) => c[0] === 'preview')).toHaveLength(4)
  })
  it('limits concurrent image requests to three', async () => {
    const bridge = mockBridge(),
      original = bridge.getMockImplementation()!
    const releases: (() => void)[] = []
    let active = 0,
      peak = 0
    bridge.mockImplementation(async (action, payload) => {
      if (action === 'ping') return original(action, payload)
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active--
      return original(action, payload)
    })
    const loader = new PreviewLoader(bridge)
    const loads = Array.from({ length: 6 }, (_, i) =>
      loader.load({ ...photo, mediaKey: String(i) }, 320)
    )
    await vi.waitFor(() => expect(releases).toHaveLength(3))
    releases.splice(0).forEach((r) => r())
    await vi.waitFor(() => expect(releases).toHaveLength(3))
    releases.splice(0).forEach((r) => r())
    await Promise.all(loads)
    expect(peak).toBe(3)
  })
  it('evicts older entries instead of caching an entire library', async () => {
    const bridge = mockBridge(),
      loader = new PreviewLoader(bridge)
    for (let i = 0; i < 33; i++)
      await loader.load({ ...photo, mediaKey: String(i) }, 320)
    await loader.load({ ...photo, mediaKey: '0' }, 320)
    expect(bridge.mock.calls.filter((c) => c[0] === 'preview')).toHaveLength(34)
  })
})
