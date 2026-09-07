<script lang="ts">
  import { previews } from '$lib/browser/previews'
  import { readPhotoFile } from '$lib/browser/files'
  import type { Photo } from '$lib/types'
  let {
    photo,
    small = false,
    class: className = '',
    loading = 'eager',
    onready,
    onfailure
  }: {
    photo: Photo
    small?: boolean
    class?: string
    loading?: 'eager' | 'lazy'
    onready?: () => void
    onfailure?: (message: string) => void
  } = $props()
  let src = $state('')
  let failure = $state('')
  $effect(() => {
    const p = photo,
      thumb = small
    let alive = true,
      blobUrl = ''
    src = ''
    failure = ''
    const load =
      p.source === 'google'
        ? previews.load(p, thumb ? 320 : 1600)
        : readPhotoFile(p)
    void load
      .then((blob) => {
        if (alive) {
          blobUrl = URL.createObjectURL(blob)
          src = blobUrl
        }
      })
      .catch((e) => {
        if (alive) {
          failure =
            e instanceof Error ? e.message : 'Unable to load this preview.'
          onfailure?.(failure)
        }
      })
    return () => {
      alive = false
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  })
</script>

{#if failure}<div
    class={className}
    role="img"
    aria-label={failure}
    title={failure}
  ></div>{:else if src}<img
    {src}
    class={className}
    alt={photo.filename}
    {loading}
    onload={() => onready?.()}
    onerror={() => {
      failure =
        'This preview is unavailable or the format is not supported by your browser.'
      onfailure?.(failure)
    }}
  />{:else}<div
    class={className}
    role="img"
    aria-label={'Loading ' + photo.filename}
  ></div>{/if}
