<script lang="ts">
  import { onMount } from 'svelte'
  import { base } from '$app/paths'
  const extensionDownload = base + '/downloads/photos-sifter-extension.zip'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Badge } from '$lib/components/ui/badge'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import * as Select from '$lib/components/ui/select'
  import {
    Check,
    Images,
    Keyboard,
    FolderOpen,
    ArrowRight,
    Trash2,
    Undo2,
    SkipForward,
    Settings2,
    Cloud,
    Download,
    ExternalLink,
    LoaderCircle,
    RefreshCw,
    ShieldCheck,
    ChevronLeft,
    ChevronRight,
    ImageOff,
    Pause,
    ListFilter,
    X
  } from '@lucide/svelte'
  import { bridge } from '$lib/bridge'
  import { review } from '$lib/browser/store'
  import { db, type FolderRecord } from '$lib/browser/db'
  import {
    activeFolder,
    folderPermission,
    indexFolderHandle,
    supportsFolderPicker
  } from '$lib/browser/files'
  import {
    downloadJson,
    exportWorkspace,
    restoreWorkspace
  } from '$lib/browser/backup'
  import PhotoImage from '$lib/components/PhotoImage.svelte'
  import { parseFilenames } from '$lib/domain'
  import type { Photo, AppState, ImportJob, Decision } from '$lib/types'
  let appState = $state<AppState>({
    imports: [],
    localCount: 0,
    root: '',
    undoCount: 0
  })
  let photos = $state<Photo[]>([]),
    importId = $state(''),
    selectedView = $state('unreviewed'),
    index = $state(0)
  let source = $state('google'),
    queryMode = $state('query'),
    query = $state('"WA"'),
    root = $state('')
  let matchOnly = $state(true),
    useList = $state(false),
    filenamesText = $state('')
  let busy = $state(false),
    importing = $state(false),
    stopRequested = $state(false),
    deleting = $state(false),
    error = $state(''),
    notice = $state(''),
    connection = $state('')
  let accounts = $state<{ tabId: number; account: string }[]>([]),
    tabValue = $state('')
  let setupOpen = $state(false),
    helpOpen = $state(false),
    deleteOpen = $state(false),
    preview = $state<{ token: string; photos: Photo[] } | null>(null)
  let removeReviewOpen = $state(false)
  let reviewToRemove = $state<ImportJob | null>(null)
  let loadedImages = $state<string[]>([])
  let failedImages = $state<string[]>([]),
    deletionProgress = $state(''),
    unresolved = $state<any[]>([]),
    currentFailed = $state(false)
  let skippedVideos = $state(0)
  let folder = $state.raw<FolderRecord | undefined>(undefined),
    allFolders = $state.raw<FolderRecord[]>([])
  let folderAccess = $state('missing'),
    folderSupported = $state(true),
    indexing = $state(false),
    indexCount = $state(0),
    persistent = $state(false),
    storageSupported = $state(false)
  let imageError = $state(''),
    indexController: AbortController | undefined

  const fmt = (n: number) => n.toLocaleString()
  let job = $derived(appState.imports.find((x) => x.id === importId))
  let queue = $derived(
    photos.filter(
      (p) =>
        !p.trashed && (selectedView === 'all' || p.decision === selectedView)
    )
  )
  let current = $derived(queue[index])
  let counts = $derived({
    all: photos.filter((p) => !p.trashed).length,
    unreviewed: photos.filter((p) => !p.trashed && p.decision === 'unreviewed')
      .length,
    keep: photos.filter((p) => !p.trashed && p.decision === 'keep').length,
    delete: photos.filter((p) => !p.trashed && p.decision === 'delete').length,
    unsure: photos.filter((p) => !p.trashed && p.decision === 'unsure').length
  })
  let marked = $derived(
    photos.filter(
      (p) =>
        !p.trashed &&
        p.decision === 'delete' &&
        p.source === 'google' &&
        p.isOwned
    )
  )
  let selectedAccount = $derived(
    accounts.find((a) => String(a.tabId) === tabValue)
  )
  let reviewed = $derived(counts.all - counts.unreviewed)
  const views = [
    { value: 'unreviewed', label: 'To review' },
    { value: 'keep', label: 'Keep' },
    { value: 'delete', label: 'Marked' },
    { value: 'unsure', label: 'Unsure' },
    { value: 'all', label: 'All' }
  ] as const
  function imageUrl(p: Photo) {
    return p.source === 'local' ? p.localPath : p.thumb
  }
  function dateLabel(p: Photo) {
    return p.timestamp
      ? new Date(p.timestamp).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        })
      : 'Date unknown'
  }
  function persist() {
    localStorage.setItem(
      'photo-review-preferences',
      JSON.stringify({
        importId,
        matchOnly,
        useList,
        filenamesText,
        selectedView,
        index,
        source,
        queryMode,
        query
      })
    )
  }
  async function refresh() {
    appState = await review('state')
    unresolved = await review('deletions')
    root = appState.root
  }
  async function loadPhotos() {
    if (!importId) {
      photos = []
      return
    }
    const names = useList ? parseFilenames(filenamesText) : []
    if (useList && !names.length)
      throw new Error(
        'Enter at least one filename, or turn the list filter off.'
      )
    const result = await review('photos', {
      importId,
      decision: 'all',
      matchOnly: job?.source === 'google' && matchOnly,
      filenames: names
    })
    photos = result.photos
    index = Math.min(index, Math.max(0, queue.length - 1))
    currentFailed = false
    persist()
  }
  async function run(fn: () => Promise<void>) {
    if (busy || deleting) return
    busy = true
    error = ''
    try {
      await fn()
    } catch (e) {
      error =
        e instanceof Error && e.name === 'QuotaExceededError'
          ? 'Browser storage is full. This change was not saved. Export your workspace before freeing space.'
          : e instanceof Error
            ? e.message
            : String(e)
    } finally {
      busy = false
    }
  }
  async function connect() {
    const result = await bridge<{ tabs: { tabId: number; account: string }[] }>(
      'ping'
    )
    accounts = result.tabs
    if (!accounts.length)
      throw new Error(
        'Open Google Photos in Chrome and sign in, then connect again.'
      )
    if (!accounts.some((a) => String(a.tabId) === tabValue))
      tabValue = String(accounts[0].tabId)
    connection = 'Connected'
  }
  function connectionPayload() {
    if (!selectedAccount)
      throw new Error('Connect to a Google Photos tab first.')
    return { tabId: selectedAccount.tabId, account: selectedAccount.account }
  }
  async function updateFolderState() {
    folder = await activeFolder()
    allFolders = await db.folders.toArray()
    folderAccess = await folderPermission(folder)
  }
  async function chooseFolder(reattachId?: string) {
    if (!supportsFolderPicker())
      throw new Error(
        'Open this app in Chrome or Edge to choose a local folder.'
      )
    let handle: FileSystemDirectoryHandle
    try {
      handle = await window.showDirectoryPicker({
        id: 'whatsapp-backup',
        mode: 'read'
      })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      throw e
    }
    indexing = true
    indexCount = 0
    indexController = new AbortController()
    try {
      await indexFolderHandle(
        handle,
        (count) => (indexCount = count),
        indexController.signal,
        reattachId
      )
      await refresh()
      await updateFolderState()
      if (importId) await loadPhotos()
      notice =
        fmt(appState.localCount) + ' local photos indexed in this browser.'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        notice = 'Indexing cancelled. The previous folder index is unchanged.'
        return
      }
      throw e
    } finally {
      indexing = false
      indexController = undefined
    }
  }
  async function reconnectFolder(selected: FolderRecord) {
    if (!selected.handle) {
      await chooseFolder(selected.id)
      return
    }
    const permission = await selected.handle.requestPermission({ mode: 'read' })
    if (permission !== 'granted')
      throw new Error(
        'Folder access was not granted. Your saved decisions are unchanged.'
      )
    await db.settings.put({ key: 'activeFolder', value: selected.id })
    await updateFolderState()
    await refresh()
    await loadPhotos()
    currentFailed = false
  }
  function reviewLabel(item: ImportJob) {
    return item.source === 'local'
      ? 'Local photos'
      : item.query || 'All Google Photos'
  }
  async function removeReview() {
    if (!reviewToRemove || importing || deleting) return
    const id = reviewToRemove.id
    await run(async () => {
      await review('imports/remove', { id })
      await refresh()
      if (importId === id) {
        importId = appState.imports[0]?.id || ''
        index = 0
        currentFailed = false
        imageError = ''
        await loadPhotos()
      }
      persist()
      removeReviewOpen = false
      reviewToRemove = null
      notice = 'Review removed. Photos and saved decisions are unchanged.'
    })
  }
  async function exportDecisions() {
    downloadJson(await review('export', { importId }), 'photo-decisions.json')
  }
  async function saveWorkspace() {
    downloadJson(await exportWorkspace(), 'photo-review-workspace.json')
    notice =
      'Workspace exported. Keep this file to restore your progress on another website or browser.'
  }
  async function importWorkspace(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    await run(async () => {
      if (file.size > 200_000_000)
        throw new Error('Workspace file is too large.')
      await restoreWorkspace(JSON.parse(await file.text()))
      await refresh()
      await updateFolderState()
      importId = appState.imports[0]?.id || ''
      index = 0
      await loadPhotos()
      notice =
        'Workspace restored. Reconnect local folders before opening local photos.'
    })
    input.value = ''
  }
  async function protectStorage() {
    persistent = await navigator.storage.persist()
    notice = persistent
      ? 'Persistent browser storage enabled. Keep a workspace export as a backup.'
      : 'The browser did not grant persistent storage. You can still review and export your workspace.'
  }
  async function startReview() {
    if (source === 'local') {
      if (!appState.folderId || !appState.localCount)
        throw new Error('Choose and index your photo folder first.')
      const result = await review('local-import', {})
      importId = result.id
      matchOnly = false
      await refresh()
      index = 0
      await loadPhotos()
      setupOpen = false
      return
    }
    const conn = connectionPayload()
    if (matchOnly && !appState.localCount)
      throw new Error(
        'Choose your backup folder first, or turn off filename matching.'
      )
    if (queryMode === 'query' && !query.trim())
      throw new Error('Enter a Google Photos query or choose All photos.')
    const result = await review('imports/create', {
      account: conn.account,
      query: queryMode === 'query' ? query : ''
    })
    importId = result.id
    index = 0
    await refresh()
    setupOpen = false
    await importMore()
  }
  async function importMore() {
    const selected = appState.imports.find((j) => j.id === importId)
    if (
      !selected ||
      selected.source !== 'google' ||
      selected.status === 'complete'
    )
      return
    const conn = connectionPayload()
    if (conn.account !== selected.account)
      throw new Error('Choose the same Google account as this import.')
    importing = true
    stopRequested = false
    skippedVideos = 0
    let cursor = selected.cursor
    try {
      while (!stopRequested) {
        const page = await bridge<any>('page', {
          ...conn,
          query: selected.query,
          cursor
        })
        await review('imports/page', {
          id: selected.id,
          account: page.account,
          expectedCursor: cursor,
          cursor: page.cursor,
          items: page.items
        })
        skippedVideos += page.skippedVideos || 0
        cursor = page.cursor
        await refresh()
        await loadPhotos()
        if (!cursor) break
        await new Promise((r) => setTimeout(r, 250))
      }
      notice = cursor
        ? 'Import paused. You can resume from the last saved page.'
        : 'Import complete. ' + fmt(job?.count || 0) + ' photos imported.'
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await review('imports/error', { id: selected.id, error: message })
      throw e
    } finally {
      importing = false
      await refresh()
    }
  }
  async function decide(decision: Decision) {
    if (!current || busy || deleting || setupOpen || deleteOpen || helpOpen)
      return
    if (decision === 'delete' && (currentFailed || !imageUrl(current))) {
      error = 'Load this photo’s preview before marking it for deletion.'
      return
    }
    const p = current,
      oldIndex = index
    await run(async () => {
      const result = await review('decision', {
        id: p.id,
        decision,
        revision: p.revision
      })
      photos = photos.map((x) =>
        x.id === p.id ? { ...x, ...result.photo } : x
      )
      if (selectedView === 'all' || selectedView === decision)
        index = Math.min(oldIndex + 1, queue.length - 1)
      else index = Math.min(oldIndex, Math.max(0, queue.length - 1))
      currentFailed = false
      await refresh()
      persist()
    })
  }
  async function undo() {
    await run(async () => {
      const { id } = await review('undo', {})
      await refresh()
      await loadPhotos()
      const at = queue.findIndex((p) => p.id === id)
      if (at >= 0) index = at
      else {
        selectedView = 'all'
        index = queue.findIndex((p) => p.id === id)
      }
      persist()
    })
  }
  function navigate(delta: number) {
    index = Math.max(0, Math.min(queue.length - 1, index + delta))
    currentFailed = false
    persist()
  }
  function handleKey(e: KeyboardEvent) {
    if (
      e.repeat ||
      busy ||
      deleting ||
      setupOpen ||
      helpOpen ||
      removeReviewOpen ||
      deleteOpen ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey
    )
      return
    const el = e.target as HTMLElement
    if (
      el.closest(
        'input,textarea,select,[contenteditable="true"],[role="combobox"],[role="dialog"],[role="alertdialog"]'
      )
    )
      return
    const key = e.key.toLowerCase()
    if (['k', 'y', 'arrowright', 'd', 'n', 'arrowleft', ' ', 'z'].includes(key))
      e.preventDefault()
    if (['k', 'y', 'arrowright'].includes(key)) void decide('keep')
    else if (['d', 'n', 'arrowleft'].includes(key)) void decide('delete')
    else if (key === ' ') void decide('unsure')
    else if (key === 'z') void undo()
  }
  async function uploadNames(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (file) {
      filenamesText = await file.text()
      useList = true
    }
  }
  async function prepareDelete() {
    if (!marked.length) return
    await run(async () => {
      preview = await review('delete-preview', {
        ids: marked.slice(0, 100).map((p) => p.id)
      })
      failedImages = []
      loadedImages = []
      deleteOpen = true
    })
  }
  async function confirmDelete() {
    if (
      !preview ||
      deleting ||
      busy ||
      failedImages.length ||
      loadedImages.length !== preview.photos.length
    )
      return
    deleting = true
    error = ''
    const snapshot = preview
    let batch = ''
    let successes = 0
    try {
      const conn = connectionPayload()
      if (conn.account !== snapshot.photos[0].account)
        throw new Error(
          'Reconnect to the Google account shown in this preview.'
        )
      const confirmed = await review('delete-confirm', {
        token: snapshot.token
      })
      batch = confirmed.batch
      for (const p of confirmed.photos as Photo[]) {
        deletionProgress = `Moving ${successes + 1} of ${confirmed.photos.length} to trash…`
        const { photo } = await review('delete-claim', { batch, id: p.id })
        try {
          const result = await bridge<{ verified: boolean }>('trash', {
            ...conn,
            item: photo,
            batch,
            confirmed: true
          })
          if (!result.verified)
            throw new Error('Deletion could not be verified.')
          await review('delete-result', { batch, id: p.id, verified: true })
          successes++
        } catch (e) {
          await review('delete-result', {
            batch,
            id: p.id,
            verified: false,
            error: e instanceof Error ? e.message : String(e)
          })
          throw e
        }
      }
      notice = `${fmt(successes)} photos moved to Google Photos’ trash. Your local files are unchanged.`
      deleteOpen = false
      preview = null
    } catch (e) {
      error =
        e instanceof Error && e.name === 'QuotaExceededError'
          ? 'Browser storage is full. This change was not saved. Export your workspace before freeing space.'
          : e instanceof Error
            ? e.message
            : String(e)
      if (batch) {
        deleteOpen = false
        preview = null
        notice = `${successes} moved to trash. The batch stopped; check the unresolved attempt below.`
      }
    } finally {
      deleting = false
      deletionProgress = ''
      await refresh()
      await loadPhotos()
    }
  }
  async function refreshPreview() {
    await run(async () => {
      if (!current || current.source !== 'google') return
      const p = current,
        conn = connectionPayload()
      if (conn.account !== p.account)
        throw new Error('Connect to this photo’s Google account.')
      const photo = await bridge<any>('refresh', {
        ...conn,
        mediaKey: p.mediaKey
      })
      const result = await review('photo-refresh', {
        id: p.id,
        account: photo.account,
        photo
      })
      photos = photos.map((x) => (x.id === p.id ? result.photo : x))
      currentFailed = false
    })
  }
  async function verifyPending() {
    await run(async () => {
      const conn = connectionPayload()
      for (const row of unresolved) {
        if (row.account !== conn.account) continue
        const result = await bridge<{ trashed: boolean }>('verify', {
          ...conn,
          mediaKey: row.mediaKey
        })
        await review('delete-resolve', {
          batch: row.batch,
          id: row.photoId,
          trashed: result.trashed
        })
      }
      await refresh()
      await loadPhotos()
      notice = 'Previous attempts checked against Google Photos.'
    })
  }
  onMount(() => {
    folderSupported = supportsFolderPicker()
    storageSupported = !!navigator.storage?.persist
    void navigator.storage?.persisted?.().then((value) => (persistent = value))
    try {
      const p = JSON.parse(
        localStorage.getItem('photo-review-preferences') || '{}'
      )
      importId = p.importId || ''
      matchOnly = p.matchOnly ?? true
      useList = p.useList ?? false
      filenamesText = p.filenamesText || ''
      selectedView = p.selectedView || 'unreviewed'
      index = p.index || 0
      source = p.source || 'google'
      queryMode = p.queryMode || 'query'
      query = p.query || '"WA"'
    } catch {}
    void run(async () => {
      await refresh()
      await updateFolderState()
      if (!appState.imports.some((j) => j.id === importId))
        importId = appState.imports[0]?.id || ''
      await loadPhotos()
    })
    const life = new AbortController()
    const context = (document as any).modelContext
    if (context?.registerTool) {
      Promise.resolve(
        context.registerTool(
          {
            name: 'photo_review_status',
            description:
              'Read the current review counts and current filename. Does not change decisions or delete photos.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute: () => ({
              counts,
              current: current
                ? { filename: current.filename, decision: current.decision }
                : null,
              importStatus: job?.status
            })
          },
          { signal: life.signal }
        )
      ).catch(() => {})
    }
    const onFocus = () => {
      if (!busy && !deleting && !setupOpen && !deleteOpen)
        void run(async () => {
          await refresh()
          await updateFolderState()
          await loadPhotos()
        })
    }
    window.addEventListener('focus', onFocus)
    return () => {
      life.abort()
      indexController?.abort()
      window.removeEventListener('focus', onFocus)
    }
  })
</script>

<svelte:head
  ><title>Photos Sifter</title><meta
    name="description"
    content="Review your photos locally. Keep the moments that matter, with decisions saved before deletion."
  /></svelte:head
>
<svelte:window onkeydown={handleKey} />
<div class="app-shell">
  <header class="app-header">
    <div class="brand-icon"><Images size={23} /></div>
    <div>
      <h1>Photos Sifter</h1>
      <p>Clean Google Photos <span>·</span> browser workspace</p>
    </div>
    <div class="header-actions">
      <Badge
        variant="outline"
        class="hidden sm:inline-flex gap-1.5 border-slate-200 bg-white text-slate-500"
        ><ShieldCheck size={13} /> Saved in this browser</Badge
      ><Button
        variant="ghost"
        size="icon"
        aria-label="Keyboard shortcuts and setup help"
        onclick={() => (helpOpen = true)}><Keyboard size={20} /></Button
      ><Button
        variant="outline"
        onclick={() => (setupOpen = true)}
        disabled={busy || deleting}><Settings2 size={16} /> Setup</Button
      >
    </div>
  </header>
  <main class="workspace">
    <aside class="sidebar">
      <div class="section-label">YOUR LIBRARY</div>
      <Button
        class="w-full justify-start gap-2"
        onclick={() => (setupOpen = true)}
        disabled={busy || deleting}><Images size={17} /> New review</Button
      >
      <div class="mt-7 flex items-center justify-between">
        <span class="section-label">REVIEWS</span><span
          class="text-xs text-slate-400">{appState.imports.length}</span
        >
      </div>
      <div class="review-list">
        {#each appState.imports as item (item.id)}<div class="review-row">
            <button
              class="review-select"
              class:active={importId === item.id}
              disabled={busy || deleting}
              onclick={() =>
                run(async () => {
                  importId = item.id
                  index = 0
                  await loadPhotos()
                })}
              >{#if item.source === 'google'}<Cloud
                  size={18}
                />{:else}<FolderOpen size={18} />{/if}
              <span
                ><strong>{reviewLabel(item)}</strong><small
                  >{fmt(item.count)} photos · {item.status === 'complete'
                    ? 'Imported'
                    : 'Paused'}</small
                ></span
              >
              {#if importId === item.id}<span class="active-dot"></span>{/if}
            </button>
            <button
              class="review-remove"
              aria-label={'Remove review ' + reviewLabel(item)}
              title="Remove review"
              disabled={busy || deleting || importing}
              onclick={() => {
                error = ''
                reviewToRemove = item
                removeReviewOpen = true
              }}><X size={16} /></button
            >
          </div>{/each}
      </div>
      {#if !appState.imports.length}<p
          class="mt-4 text-sm leading-relaxed text-slate-400"
        >
          Your review sessions will appear here.
        </p>{/if}
      {#if job}<div class="mt-7 border-t pt-5">
          <div class="section-label mb-3">REVIEW FILTERS</div>
          <label class="check-label"
            ><Checkbox
              bind:checked={matchOnly}
              disabled={job.source === 'local' || busy || deleting}
            /><span>Match local filenames</span></label
          ><label class="check-label mt-3"
            ><Checkbox
              bind:checked={useList}
              disabled={busy || deleting}
            /><span>Use a filename list</span></label
          >{#if useList}<Textarea
              class="mt-3 h-28 text-xs"
              bind:value={filenamesText}
              placeholder="IMG-20260713-WA0019.jpg"
            /><label class="mt-2 block text-xs text-slate-500"
              >Load .txt or .json<input
                type="file"
                accept=".txt,.json"
                onchange={uploadNames}
                class="mt-1 w-full text-xs"
              /></label
            >{/if}<Button
            variant="outline"
            size="sm"
            class="mt-4 w-full"
            disabled={busy || deleting}
            onclick={() =>
              run(async () => {
                index = 0
                await loadPhotos()
              })}><ListFilter size={14} /> Apply filters</Button
          >
        </div>{/if}
      <div class="sidebar-bottom">
        <div class="flex items-center gap-2 text-sm font-medium text-slate-600">
          <FolderOpen size={16} /> Local backup
        </div>
        <p class="mt-1 text-xs text-slate-400">
          {fmt(appState.localCount)} photos indexed
        </p>
        <p class="mt-3 text-xs leading-relaxed text-slate-400">
          Reviewing never changes the original files.
        </p>
      </div>
    </aside>
    <section class="review-main">
      {#if error}<div role="alert" class="notice error">
          <span>{error}</span><button
            aria-label="Dismiss error"
            onclick={() => (error = '')}><X size={16} /></button
          >
        </div>{/if}
      {#if notice}<div role="status" class="notice">
          <span>{notice}</span><button
            aria-label="Dismiss notice"
            onclick={() => (notice = '')}><X size={16} /></button
          >
        </div>{/if}
      {#if unresolved.length}<div class="notice error">
          <span
            >{unresolved.length} deletion attempt(s) need verification. They will
            not be retried automatically.</span
          ><Button
            size="sm"
            variant="outline"
            disabled={busy || deleting}
            onclick={verifyPending}>Check status</Button
          >
        </div>{/if}
      <div class="review-heading">
        <div>
          <div class="section-label">
            {job?.source === 'google'
              ? 'GOOGLE PHOTOS'
              : job
                ? 'LOCAL PHOTOS'
                : 'PHOTO WORKSPACE'}
          </div>
          <h2>
            {job
              ? job.source === 'google'
                ? job.query || 'All your photos'
                : 'Your local photos'
              : 'Choose what stays.'}
          </h2>
        </div>
        <div class="flex items-center gap-2">
          {#if job?.source === 'google' && job.status !== 'complete'}{#if importing}<Button
                variant="outline"
                size="sm"
                onclick={() => (stopRequested = true)}
                ><Pause size={14} /> Pause import</Button
              >{:else}<Button
                variant="outline"
                size="sm"
                disabled={busy || deleting}
                onclick={() => run(importMore)}
                ><RefreshCw size={14} /> Resume import</Button
              >{/if}{/if}{#if job}<Button
              variant="ghost"
              size="sm"
              onclick={() => run(exportDecisions)}
              disabled={busy || deleting}
              ><Download size={15} /><span class="hidden sm:inline"
                >Export decisions</span
              ></Button
            >{/if}
        </div>
      </div>
      {#if importing}<div
          class="mb-4 flex items-center gap-2 text-sm text-indigo-600"
        >
          <LoaderCircle size={16} class="animate-spin" /> Importing… {fmt(
            job?.count || 0
          )} photos saved{skippedVideos
            ? `, ${fmt(skippedVideos)} videos skipped`
            : ''}. You can resume if interrupted.
        </div>{/if}
      {#if job?.error && !importing}<p class="mb-4 text-sm text-amber-700">
          Import paused: {job.error}
        </p>{/if}
      {#if appState.imports.length}<select
          aria-label="Choose review"
          class="native-select mb-4 mobile-review-select"
          value={importId}
          disabled={busy || deleting}
          onchange={(e) =>
            run(async () => {
              importId = e.currentTarget.value
              index = 0
              await loadPhotos()
            })}
          >{#each appState.imports as item}<option value={item.id}
              >{item.source === 'local'
                ? 'Local photos'
                : item.query || 'All Google Photos'} · {fmt(item.count)}</option
            >{/each}</select
        >{/if}
      {#if job}<Button
          class="mobile-review-remove mb-4"
          variant="ghost"
          size="sm"
          disabled={busy || deleting || importing}
          onclick={() => {
            error = ''
            reviewToRemove = job || null
            removeReviewOpen = true
          }}><X size={15} /> Remove this review</Button
        >{/if}
      <div class="review-tabs" role="tablist" aria-label="Review decisions">
        {#each views as view}<button
            role="tab"
            aria-selected={selectedView === view.value}
            class:chosen={selectedView === view.value}
            disabled={busy || deleting}
            onclick={() => {
              selectedView = view.value
              index = 0
              currentFailed = false
              persist()
            }}>{view.label}<span>{fmt(counts[view.value])}</span></button
          >{/each}
      </div>
      <div class="photo-stage">
        {#if current}
          {#key current.id}<PhotoImage
              class="main-photo"
              photo={current}
              onready={() => {
                currentFailed = false
                imageError = ''
              }}
              onfailure={(message) => {
                currentFailed = true
                imageError = message
              }}
            />{/key}
          {#if currentFailed || !imageUrl(current)}<div class="image-error">
              <ImageOff size={36} />
              <h3>Preview unavailable</h3>
              <p>
                {imageError ||
                  'The image may be unsupported or its Google preview may have expired.'}
              </p>
              {#if current.source === 'local'}<Button
                  variant="secondary"
                  onclick={() => (setupOpen = true)}>Reconnect folder</Button
                >{/if}{#if current.source === 'google'}<Button
                  variant="secondary"
                  disabled={busy}
                  onclick={refreshPreview}
                  ><RefreshCw size={15} /> Refresh preview</Button
                ><Button
                  variant="secondary"
                  href={'https://photos.google.com/photo/' + current.mediaKey}
                  target="_blank"
                  rel="noreferrer"
                  >Open in Google Photos <ExternalLink size={15} /></Button
                >{/if}
            </div>{/if}
          <div class="stage-top">
            <span
              >{fmt(index + 1)}
              <span class="text-white/40">/ {fmt(queue.length)}</span></span
            ><span class="stage-pill"
              >{current.source === 'local'
                ? 'Local preview'
                : 'Google preview'}</span
            >
          </div>
          <button
            class="stage-nav prev"
            aria-label="Previous photo"
            disabled={index === 0 || busy || deleting}
            onclick={() => navigate(-1)}><ChevronLeft size={22} /></button
          ><button
            class="stage-nav next"
            aria-label="Next photo without deciding"
            disabled={index >= queue.length - 1 || busy || deleting}
            onclick={() => navigate(1)}><ChevronRight size={22} /></button
          >
        {:else}<div class="stage-empty">
            {#if busy}<LoaderCircle
                size={36}
                class="animate-spin text-indigo-300"
              />
              <h3>Preparing your review…</h3>{:else if job && counts.all}<div
                class="empty-check"
              >
                <Check size={30} />
              </div>
              <h3>
                {selectedView === 'unreviewed'
                  ? 'You’re all caught up.'
                  : 'Nothing here yet.'}
              </h3>
              <p>
                {selectedView === 'unreviewed'
                  ? 'Your decisions are saved. You can revisit any photo in the tabs above.'
                  : 'Photos with this decision will appear here.'}
              </p>{:else}<Images size={42} class="text-indigo-300" />
              <h3>
                {job
                  ? 'No photos match these filters.'
                  : 'A fresh look at your library.'}
              </h3>
              <p>
                {job
                  ? 'Adjust your filename filters, or finish importing this review.'
                  : 'Start with your WhatsApp backup or connect Google Photos. Keep, mark, or come back to it later.'}
              </p>
              <Button
                class="mt-5"
                onclick={() => (setupOpen = true)}
                disabled={busy}>Choose photos <ArrowRight size={16} /></Button
              >{/if}
          </div>{/if}
      </div>
      <div class="photo-meta">
        <div>
          <strong>{current?.filename || 'No photo selected'}</strong>
          <p>
            {current
              ? dateLabel(current)
              : 'Your next review starts here.'}{#if current && current.width}
              <span>· {current.width} × {current.height}</span
              >{/if}{#if current?.localMatches}<span>
                · {current.localMatches === 1
                  ? 'Backup match'
                  : 'Multiple backup matches'}</span
              >{/if}
          </p>
        </div>
        {#if current?.source === 'google'}<a
            class="text-slate-400 hover:text-indigo-600"
            aria-label="Open current photo in Google Photos"
            href={'https://photos.google.com/photo/' + current.mediaKey}
            target="_blank"
            rel="noreferrer"><ExternalLink size={18} /></a
          >{/if}{#if current && current.decision !== 'unreviewed'}<Badge
            variant="outline"
            >{current.decision === 'delete'
              ? 'Marked for deletion'
              : current.decision}</Badge
          >{/if}
      </div>
      <div class="decision-bar">
        <Button
          class="decision-button mark-button"
          variant="outline"
          disabled={!current || currentFailed || busy || deleting}
          onclick={() => decide('delete')}
          ><Trash2 size={18} /><span>Mark for deletion</span><kbd>D</kbd
          ></Button
        ><Button
          class="decision-button skip-button"
          variant="outline"
          disabled={!current || busy || deleting}
          onclick={() => decide('unsure')}
          ><SkipForward size={18} /><span>Unsure</span><kbd>Space</kbd></Button
        ><Button
          class="decision-button keep-button"
          disabled={!current || busy || deleting}
          onclick={() => decide('keep')}
          ><Check size={20} /><span>Keep photo</span><kbd>K</kbd></Button
        >
      </div>
      <div class="review-footer">
        <Button
          variant="ghost"
          size="sm"
          disabled={!appState.undoCount || busy || deleting}
          onclick={undo}><Undo2 size={15} /> Undo <kbd>Z</kbd></Button
        ><span class="text-xs text-slate-400 hidden sm:block"
          >← mark · → keep · Space unsure</span
        ><span class="text-sm text-slate-500"
          >{fmt(reviewed)} of {fmt(counts.all)} reviewed</span
        >
      </div>
      <div class="progress-track">
        <div
          style:width={(counts.all ? (reviewed / counts.all) * 100 : 0) + '%'}
        ></div>
      </div>
      {#if queue.length > 1}<div class="filmstrip" aria-label="Upcoming photos">
          {#each queue.slice(Math.max(0, index - 2), index + 7) as p}<button
              class:selected={p.id === current?.id}
              aria-label={'Review ' + p.filename}
              disabled={busy || deleting}
              onclick={() => {
                index = queue.findIndex((x) => x.id === p.id)
                currentFailed = false
                persist()
              }}
              ><PhotoImage
                photo={p}
                small
                loading="lazy"
              />{#if p.decision === 'keep'}<Check
                  size={12}
                />{:else if p.decision === 'delete'}<Trash2
                  size={12}
                />{/if}</button
            >{/each}
        </div>{/if}
      {#if counts.delete}<div class="deletion-summary">
          <div>
            <strong>{fmt(counts.delete)} marked for deletion</strong>
            <p>
              {job?.source === 'local'
                ? 'These are saved decisions only. Export them or import Google Photos to review cloud copies.'
                : 'Nothing has been deleted. Preview the selection when you’re ready.'}
            </p>
          </div>
          {#if marked.length}<Button
              variant="destructive"
              disabled={busy || deleting}
              onclick={prepareDelete}
              ><Trash2 size={16} /> Delete {Math.min(marked.length, 100)} photos…</Button
            >{:else}<Button
              variant="outline"
              onclick={() => run(exportDecisions)}
              disabled={busy || deleting}
              ><Download size={16} /> Export decisions</Button
            >{/if}
        </div>{/if}
    </section>
  </main>
</div>
<Dialog.Root bind:open={setupOpen}
  ><Dialog.Content class="sm:max-w-2xl max-h-[90vh] overflow-y-auto"
    ><Dialog.Header
      ><Dialog.Title class="text-2xl">Start a review</Dialog.Title
      ><Dialog.Description
        >Choose a source. Add filename filters if you want a smaller queue.</Dialog.Description
      ></Dialog.Header
    >
    <div class="setup-grid">
      <label class="field-label"
        >Photo source<Select.Root type="single" bind:value={source}
          ><Select.Trigger class="w-full"
            >{source === 'google'
              ? 'Google Photos'
              : 'Local folder'}</Select.Trigger
          ><Select.Content
            ><Select.Item value="google">Google Photos</Select.Item><Select.Item
              value="local">Local folder</Select.Item
            ></Select.Content
          ></Select.Root
        ></label
      >
      {#if source === 'google'}<div class="connection-panel">
          <div class="flex items-center justify-between gap-3">
            <div>
              <strong>Chrome companion</strong>
              <p>{connection || 'Connect your signed-in Google Photos tab.'}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={() => run(connect)}><Cloud size={15} /> Connect</Button
            >
          </div>
          <div class="mt-3">
            <Button
              variant="outline"
              size="sm"
              href={extensionDownload}
              download="photos-sifter-extension.zip"
              ><Download size={15} /> Download Chrome extension</Button
            >
            <p class="mt-2">
              Unzip the download, then follow the installation instructions
              below.
            </p>
          </div>
          {#if accounts.length}<label class="field-label mt-3"
              >Google Photos account<select
                class="native-select"
                bind:value={tabValue}
                >{#each accounts as a}<option value={String(a.tabId)}
                    >{a.account} · tab {a.tabId}</option
                  >{/each}</select
              ></label
            >{:else}<button
              class="mt-3 text-sm text-indigo-600 underline underline-offset-4"
              onclick={() => (helpOpen = true)}
              >How to install the extension</button
            >{/if}
        </div>
        <label class="field-label"
          >Import from<Select.Root type="single" bind:value={queryMode}
            ><Select.Trigger class="w-full"
              >{queryMode === 'query'
                ? 'Google Photos search'
                : 'All Google Photos'}</Select.Trigger
            ><Select.Content
              ><Select.Item value="query">Google Photos search</Select.Item
              ><Select.Item value="all">All Google Photos</Select.Item
              ></Select.Content
            ></Select.Root
          ></label
        >{#if queryMode === 'query'}<label class="field-label"
            >Search query<Input bind:value={query} placeholder={'"WA"'} /><span
              class="field-hint"
              >Uses Google Photos search, including any false positives.</span
            ></label
          >{/if}
        <label class="check-label"
          ><Checkbox bind:checked={matchOnly} /><span
            >Only photos with a matching filename in my local folder</span
          ></label
        >{/if}
      {#if source === 'local' || matchOnly}<div class="field-label">
          <span>Local photo folder</span>
          <div class="connection-panel">
            <strong>{root || 'Choose your WhatsApp backup'}</strong>
            <p>
              {appState.localCount
                ? fmt(appState.localCount) + ' photos indexed · '
                : ''}{folderAccess === 'granted'
                ? 'Read access granted'
                : folder
                  ? 'Folder access needed for local previews'
                  : 'No folder selected'}
            </p>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || !folderSupported}
                onclick={() => run(() => chooseFolder())}
                ><FolderOpen size={16} />
                {folder ? 'Choose or reindex folder' : 'Choose folder'}</Button
              >
              {#if folder && folderAccess !== 'granted'}<Button
                  variant="outline"
                  disabled={busy}
                  onclick={() => run(() => reconnectFolder(folder!))}
                  >Reconnect folder</Button
                >{/if}
            </div>
            {#if indexing}<p role="status" class="mt-3">
                Indexing… {fmt(indexCount)} photos found.
              </p>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => indexController?.abort()}>Cancel indexing</Button
              >{/if}
            {#if !folderSupported}<p class="mt-3 text-amber-700">
                Folder selection needs Chrome or Edge. Google imports and saved
                reviews can still be used in supported browsers.
              </p>{/if}
          </div>
          <span class="field-hint"
            >Select WhatsApp Images inside Pictures/WhatsApp. Includes
            subfolders. The app requests read access only.</span
          >
          {#if allFolders.length > 1}<div class="flex flex-wrap gap-2">
              {#each allFolders.filter((f) => f.id !== folder?.id) as saved}<Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onclick={() => run(() => reconnectFolder(saved))}
                  >Use {saved.name}</Button
                >{/each}
            </div>{/if}
        </div>{/if}
      <label class="check-label"
        ><Checkbox bind:checked={useList} /><span
          >Limit to a list of filenames</span
        ></label
      >{#if useList}<Textarea
          bind:value={filenamesText}
          placeholder="One exact filename per line, or a JSON array"
          class="min-h-28"
        /><input type="file" accept=".txt,.json" onchange={uploadNames} />{/if}
    </div>
    <div class="connection-panel mb-4">
      <strong>Saved in this browser</strong>
      <p>
        Your reviews stay on this device and website. Export a workspace before
        switching to GitHub Pages.
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || deleting}
          onclick={() => run(saveWorkspace)}
          ><Download size={15} /> Export workspace</Button
        ><label class="text-sm"
          >Restore workspace<input
            class="mt-1 block max-w-56 text-xs"
            type="file"
            accept=".json"
            disabled={busy || deleting}
            onchange={importWorkspace}
          /></label
        >
      </div>
      <div class="mt-3 text-xs text-slate-500">
        {persistent
          ? 'Persistent storage granted. Clearing site data still removes this workspace.'
          : 'Browser storage may be cleared. Keep a workspace export as a backup.'}
      </div>
      {#if !persistent && storageSupported}<Button
          class="mt-2"
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => run(protectStorage)}>Keep data on this device</Button
        >{/if}
    </div>
    <Dialog.Footer
      ><Button
        variant="outline"
        disabled={busy}
        onclick={() => (setupOpen = false)}>Cancel</Button
      ><Button disabled={busy || deleting} onclick={() => run(startReview)}
        >{#if busy}<LoaderCircle
            size={16}
            class="animate-spin"
          />{/if}{source === 'local'
          ? 'Start local review'
          : 'Import & start review'}<ArrowRight size={16} /></Button
      ></Dialog.Footer
    >{#if error}<p role="alert" class="text-sm text-red-600">
        {error}
      </p>{/if}</Dialog.Content
  ></Dialog.Root
>
<AlertDialog.Root bind:open={removeReviewOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Remove this review?</AlertDialog.Title>
      <AlertDialog.Description>
        This removes the review from your list. Your Google Photos, local files,
        and saved keep/delete decisions stay unchanged. Importing these photos
        again will reuse their saved decisions.
      </AlertDialog.Description>
    </AlertDialog.Header>
    {#if reviewToRemove}<div class="rounded-lg border p-3 text-sm">
        <strong>{reviewLabel(reviewToRemove)}</strong>
        <p class="mt-1 text-slate-500">
          {fmt(reviewToRemove.count)} photos · Created {new Date(
            reviewToRemove.created
          ).toLocaleString()}
        </p>
      </div>{/if}
    {#if error}<p role="alert" class="text-sm text-red-600">{error}</p>{/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={busy}>Cancel</AlertDialog.Cancel>
      <Button
        variant="destructive"
        disabled={busy || importing || deleting}
        onclick={removeReview}
      >
        {#if busy}<LoaderCircle size={16} class="animate-spin" />{/if}Remove
        review
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
<AlertDialog.Root bind:open={deleteOpen}
  ><AlertDialog.Content class="sm:max-w-4xl max-h-[90vh] flex flex-col"
    ><AlertDialog.Header
      ><AlertDialog.Title class="text-2xl"
        >Delete these {preview?.photos.length || 0} photos?</AlertDialog.Title
      ><AlertDialog.Description
        >Check the images below, then click Delete again to move them to Google
        Photos’ trash. This can also affect synced devices. Your local backup
        will stay unchanged.</AlertDialog.Description
      ></AlertDialog.Header
    >
    {#if preview}<div class="flex items-center justify-between gap-3 text-sm">
        <Badge variant="outline">{preview.photos[0]?.account}</Badge><span
          class="text-slate-500"
          >{marked.length > 100
            ? 'First 100 marked photos · '
            : ''}{loadedImages.length} of {preview.photos.length} previews loaded</span
        >
      </div>
      <div class="delete-grid">
        {#each preview.photos as p}<div>
            <PhotoImage
              photo={p}
              small
              onready={() => {
                if (!loadedImages.includes(p.id))
                  loadedImages = [...loadedImages, p.id]
              }}
              onfailure={() => {
                if (!failedImages.includes(p.id))
                  failedImages = [...failedImages, p.id]
              }}
            /><span title={p.filename}>{p.filename}</span>
          </div>{/each}
      </div>{/if}
    {#if failedImages.length}<p class="text-sm text-red-600">
        Some previews could not be loaded. Cancel and check those photos before
        deleting.
      </p>{/if}{#if error}<p role="alert" class="text-sm text-red-600">
        {error}
      </p>{/if}{#if deleting}<p role="status" class="text-sm text-indigo-600">
        {deletionProgress} Keep both tabs open.
      </p>{/if}
    <AlertDialog.Footer
      ><AlertDialog.Cancel disabled={deleting}
        >Keep reviewing</AlertDialog.Cancel
      ><Button
        variant="destructive"
        disabled={deleting ||
          busy ||
          failedImages.length > 0 ||
          !preview ||
          loadedImages.length !== preview.photos.length}
        onclick={confirmDelete}
        >{#if deleting}<LoaderCircle
            size={16}
            class="animate-spin"
          />{:else}<Trash2 size={16} />{/if}Delete {preview?.photos.length || 0} photos</Button
      ></AlertDialog.Footer
    ></AlertDialog.Content
  ></AlertDialog.Root
>
<Dialog.Root bind:open={helpOpen}
  ><Dialog.Content class="sm:max-w-xl max-h-[85vh] overflow-y-auto"
    ><Dialog.Header
      ><Dialog.Title>Make yourself at home</Dialog.Title><Dialog.Description
        >Everything runs in your browser. Your Google login stays in Chrome.</Dialog.Description
      ></Dialog.Header
    >
    <div class="space-y-5 text-sm leading-relaxed">
      <div>
        <h3 class="font-semibold mb-2">Keyboard controls</h3>
        <div class="shortcut-grid">
          <kbd>K / Y / →</kbd><span>Keep photo</span><kbd>D / N / ←</kbd><span
            >Mark for deletion</span
          ><kbd>Space</kbd><span>Unsure, decide later</span><kbd>Z</kbd><span
            >Undo the last decision</span
          >
        </div>
      </div>
      <div>
        <h3 class="font-semibold mb-2">Connect Google Photos</h3>
        <Button
          class="mb-3"
          variant="outline"
          href={extensionDownload}
          download="photos-sifter-extension.zip"
          ><Download size={16} /> Download Chrome extension</Button
        >
        <ol class="list-decimal space-y-2 pl-5">
          <li>
            Download the extension above and unzip it. Keep the extracted folder
            while the extension is installed.
          </li>
          <li>
            In Chrome, open <code>chrome://extensions</code> and enable Developer
            mode.
          </li>
          <li>
            Choose <strong>Load unpacked</strong> and select the extracted
            <code>photos-sifter-extension</code>
            folder containing <code>manifest.json</code>.
          </li>
          <li>
            Open <a
              href="https://photos.google.com"
              target="_blank"
              rel="noreferrer"
              class="text-indigo-600 underline">Google Photos</a
            > and sign in.
          </li>
          <li>
            Open this app in Chrome. The companion is configured for <code
              >bertspaan.nl/photos-sifter</code
            >
            and localhost. After updating the extension, reload it in Chrome’s extensions
            page, reload the app, and choose <strong>Setup → Connect</strong>.
          </li>
        </ol>
      </div>
      <p class="rounded-lg bg-amber-50 p-3 text-amber-900">
        The connector uses Google Photos’ undocumented website API. If Google
        changes it, imports pause and uncertain deletions require verification.
        Never use “empty trash” during this review.
      </p>
      <p>
        Local-folder reviews also work without the extension. Use Export
        decisions to save a portable list of your choices.
      </p>
    </div>
    <Dialog.Footer
      ><Button onclick={() => (helpOpen = false)}>Got it</Button></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>
