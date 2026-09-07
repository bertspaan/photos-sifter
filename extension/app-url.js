export const APP_URL = 'https://bertspaan.nl/photos-sifter/'
/** Only the user's specific published app and local development origin can call the companion.
 * @param {string} value
 */
export function isAllowedAppUrl(value) {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (['http://127.0.0.1:5178', 'http://localhost:5178'].includes(url.origin))
      return true
    const app = new URL(APP_URL)
    return (
      url.origin === app.origin &&
      (url.pathname === app.pathname.slice(0, -1) ||
        url.pathname.startsWith(app.pathname))
    )
  } catch {
    return false
  }
}
