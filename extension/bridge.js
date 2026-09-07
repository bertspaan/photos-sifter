// Guard against duplicate injection and messages from other local ports.
;(() => {
  if (window !== window.top || globalThis.__photoReviewBridgeInstalled) return
  if (
    location.protocol === 'http:' &&
    !['http://127.0.0.1:5178', 'http://localhost:5178'].includes(
      location.origin
    )
  )
    return
  globalThis.__photoReviewBridgeInstalled = true
  const CHANNEL = 'clean-google-photos-v1'
  window.addEventListener('message', async (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== CHANNEL ||
      event.data.direction !== 'request'
    )
      return
    const { id, action, payload } = event.data
    if (
      typeof id !== 'string' ||
      !['ping', 'page', 'trash', 'verify', 'refresh', 'preview'].includes(
        action
      )
    )
      return
    try {
      const response = await chrome.runtime.sendMessage({ action, payload })
      window.postMessage(
        { channel: CHANNEL, direction: 'response', id, ...response },
        location.origin
      )
    } catch (e) {
      window.postMessage(
        {
          channel: CHANNEL,
          direction: 'response',
          id,
          error: e.message || 'Extension disconnected. Reload this tab.'
        },
        location.origin
      )
    }
  })
})()
