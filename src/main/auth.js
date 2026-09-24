import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { clearGoogleAuth, loadGoogleTokens, saveGoogleTokens, store } from './store.js'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo'
const TASKS_API = 'https://tasks.googleapis.com/tasks/v1'
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

// calendar.readonly is needed for resolveTaskDueAt below -- a task's own
// `due` field never carries a time of day (Google truncates it to midnight
// regardless of what the Tasks app's date/time picker shows), but a task
// that's been time-blocked from Calendar's "click a slot > Task" flow gets a
// real timed event we can look up.
const SCOPES = [
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email'
]

/** Refresh this long before actual expiry, so a call never races the clock. */
const EXPIRY_SKEW_MS = 60_000

const base64url = (buf) => buf.toString('base64url')

/**
 * Credentials resolve in three steps so you can configure the app either at
 * build time or after installing, without rebuilding:
 *   1. MAIN_VITE_GOOGLE_* baked in by electron-vite from .env
 *   2. the same names in the runtime environment
 *   3. google-oauth.json dropped into the userData directory
 */
function resolveCredentials() {
  const fromBuild = {
    clientId: import.meta.env?.MAIN_VITE_GOOGLE_CLIENT_ID,
    clientSecret: import.meta.env?.MAIN_VITE_GOOGLE_CLIENT_SECRET
  }
  if (fromBuild.clientId) return fromBuild

  if (process.env.MAIN_VITE_GOOGLE_CLIENT_ID) {
    return {
      clientId: process.env.MAIN_VITE_GOOGLE_CLIENT_ID,
      clientSecret: process.env.MAIN_VITE_GOOGLE_CLIENT_SECRET
    }
  }

  try {
    const path = join(app.getPath('userData'), 'google-oauth.json')
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed.clientId) {
        return { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
      }
    }
  } catch (err) {
    console.warn('[auth] could not read google-oauth.json:', err.message)
  }

  return { clientId: null, clientSecret: null }
}

/**
 * Shown briefly in the user's real browser (not the app) after the OAuth
 * redirect lands -- see createGoogleAuth's doc comment for why it's the
 * system browser and not a BrowserWindow. Kept in the same monochrome,
 * OS-driven palette as the app itself via a plain prefers-color-scheme media
 * query, since this page has no access to the app's own CSS.
 */
function resultPage(title, message, ok) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root { --surface: #ffffff; --ink: #18181b; --ink-muted: #71717a; --accent: #18181b; --danger: #dc2626; }
  @media (prefers-color-scheme: dark) {
    :root { --surface: #0a0a0a; --ink: #f4f4f5; --ink-muted: #a1a1aa; --accent: #fafafa; --danger: #f87171; }
  }
  body {
    margin: 0; display: grid; place-items: center; height: 100vh;
    font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: var(--surface); color: var(--ink);
  }
  .badge {
    width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 1.25rem;
    display: grid; place-items: center; font-size: 28px; font-weight: 600;
    background: ${ok ? 'var(--accent)' : 'var(--danger)'};
    color: ${ok ? 'var(--surface)' : '#ffffff'};
  }
</style>
</head>
<body>
  <div style="text-align:center;max-width:26rem;padding:2rem">
    <div class="badge">${ok ? '&#10003;' : '!'}</div>
    <h1 style="font-size:1.25rem;margin:0 0 .5rem">${title}</h1>
    <p style="margin:0;color:var(--ink-muted)">${message}</p>
  </div>
</body></html>`
}

/**
 * Google OAuth for an *installed app*: loopback redirect plus PKCE.
 *
 * The consent screen opens in the user's real browser rather than a
 * BrowserWindow -- Google blocks OAuth inside embedded webviews, and the
 * system browser is what their docs prescribe for desktop clients. It also
 * means the user gets their existing Google session and password manager.
 *
 * The redirect lands on the Express server we already run. Google ignores the
 * port for loopback redirect URIs on installed-app clients, which is what lets
 * our dynamic port fallback work without reconfiguring the Cloud Console.
 *
 * @param {object}   opts
 * @param {Function} opts.getPort  returns the live Express port
 * @param {Function} [opts.onChange] called after sign-in/sign-out
 */
export function createGoogleAuth({ getPort, onChange = () => {} }) {
  /** @type {{verifier: string, state: string, createdAt: number} | null} */
  let pending = null

  const redirectUri = () => `http://127.0.0.1:${getPort()}/oauth/callback`

  function isConfigured() {
    return Boolean(resolveCredentials().clientId)
  }

  function getStatus() {
    const tokens = loadGoogleTokens()
    return {
      configured: isConfigured(),
      connected: Boolean(tokens?.refresh_token || tokens?.access_token),
      email: store.get('googleAccountEmail'),
      redirectUri: getPort() ? redirectUri() : null
    }
  }

  async function beginAuth() {
    const { clientId } = resolveCredentials()
    if (!clientId) {
      throw new Error(
        'Google OAuth is not configured. Add MAIN_VITE_GOOGLE_CLIENT_ID to .env (see README).'
      )
    }

    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(16))
    pending = { verifier, state, createdAt: Date.now() }

    const url = new URL(AUTH_ENDPOINT)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPES.join(' '))
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    // Required together to actually receive a refresh token; without them a
    // returning user gets an access token only and breaks after an hour.
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')

    await shell.openExternal(url.toString())
    return { started: true }
  }

  async function handleOAuthCallback(query) {
    if (query.error) {
      pending = null
      return {
        ok: false,
        html: resultPage('Sign-in cancelled', `Google reported: ${query.error}`, false)
      }
    }

    if (!pending) {
      return {
        ok: false,
        html: resultPage('No sign-in in progress', 'Start the sign-in from the app first.', false)
      }
    }

    // Guard against a stale attempt being replayed much later.
    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      pending = null
      return {
        ok: false,
        html: resultPage('Sign-in expired', 'That took too long. Please try again.', false)
      }
    }

    const expected = Buffer.from(pending.state)
    const provided = Buffer.from(String(query.state ?? ''))
    const stateOk = expected.length === provided.length && timingSafeEqual(expected, provided)
    if (!stateOk) {
      pending = null
      return {
        ok: false,
        html: resultPage('Sign-in rejected', 'The security check failed. Please try again.', false)
      }
    }

    const { verifier } = pending
    pending = null

    try {
      const { clientId, clientSecret } = resolveCredentials()
      const body = new URLSearchParams({
        code: String(query.code ?? ''),
        client_id: clientId,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: verifier
      })
      // Desktop clients are issued a secret even though it cannot be kept
      // confidential -- that is exactly why PKCE above is doing the real work.
      if (clientSecret) body.set('client_secret', clientSecret)

      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`)

      persistTokens(data)
      await captureAccountEmail()
      onChange(getStatus())

      return {
        ok: true,
        html: resultPage('Connected to Google', 'You can close this tab and return to Timer.', true)
      }
    } catch (err) {
      console.error('[auth] token exchange failed:', err)
      return { ok: false, html: resultPage('Sign-in failed', err.message, false) }
    }
  }

  function persistTokens(data) {
    const existing = loadGoogleTokens() ?? {}
    saveGoogleTokens({
      access_token: data.access_token,
      // A refresh response omits refresh_token; keep the one we already have.
      refresh_token: data.refresh_token ?? existing.refresh_token ?? null,
      scope: data.scope ?? existing.scope,
      token_type: data.token_type ?? 'Bearer',
      expires_at: Date.now() + (Number(data.expires_in ?? 3600) * 1000)
    })
  }

  async function refreshAccessToken(tokens) {
    if (!tokens?.refresh_token) {
      throw new Error('Not signed in to Google (no refresh token). Please connect again.')
    }
    const { clientId, clientSecret } = resolveCredentials()
    const body = new URLSearchParams({
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token'
    })
    if (clientSecret) body.set('client_secret', clientSecret)

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    const data = await res.json()
    if (!res.ok) {
      // invalid_grant means the grant was revoked or expired for good; there
      // is no recovering from it, so drop the session rather than retry-loop.
      if (data.error === 'invalid_grant') {
        clearGoogleAuth()
        onChange(getStatus())
      }
      throw new Error(data.error_description || data.error || `HTTP ${res.status}`)
    }

    persistTokens(data)
    return loadGoogleTokens()
  }

  async function getAccessToken() {
    let tokens = loadGoogleTokens()
    if (!tokens) throw new Error('Not signed in to Google.')
    if (!tokens.access_token || Date.now() >= (tokens.expires_at ?? 0) - EXPIRY_SKEW_MS) {
      tokens = await refreshAccessToken(tokens)
    }
    return tokens.access_token
  }

  /**
   * Authenticated Google API call with a single refresh-and-retry on 401.
   * Covers the case where a token is revoked between our expiry check and the
   * request actually landing.
   */
  async function apiFetch(url, options = {}, { retry = true } = {}) {
    const accessToken = await getAccessToken()
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    })

    if (res.status === 401 && retry) {
      await refreshAccessToken(loadGoogleTokens())
      return apiFetch(url, options, { retry: false })
    }

    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    if (!res.ok) {
      throw new Error(data?.error?.message || `Google API error ${res.status}`)
    }
    return data
  }

  async function captureAccountEmail() {
    try {
      const info = await apiFetch(USERINFO_ENDPOINT)
      if (info.email) store.set('googleAccountEmail', info.email)
    } catch (err) {
      // Cosmetic only -- never block sign-in over a missing display name.
      console.warn('[auth] could not read account email:', err.message)
    }
  }

  async function signOut() {
    const tokens = loadGoogleTokens()
    const token = tokens?.refresh_token ?? tokens?.access_token
    if (token) {
      try {
        await fetch(REVOKE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token })
        })
      } catch (err) {
        // Revocation is best-effort; local state is cleared regardless.
        console.warn('[auth] revoke failed:', err.message)
      }
    }
    clearGoogleAuth()
    onChange(getStatus())
    return getStatus()
  }

  /* ------------------------------------------------- Google Tasks sample */

  async function listTaskLists() {
    const data = await apiFetch(`${TASKS_API}/users/@me/lists?maxResults=100`)
    return (data.items ?? []).map((l) => ({ id: l.id, title: l.title }))
  }

  async function listTasks(taskListId) {
    const url = `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks?showCompleted=false&maxResults=100`
    const data = await apiFetch(url)
    // `due` is always midnight UTC in practice -- Google truncates the time
    // of day regardless of what the Tasks app's date/time picker shows, so
    // it's only ever useful as a date. A real time comes from a linked
    // Calendar focus-time block instead; see resolveTaskDueAt.
    return (data.items ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      due: t.due ?? null,
      webViewLink: t.webViewLink ?? null
    }))
  }

  /** The opaque id Google uses in a task's tasks.google.com/task/<id> link. */
  function extractTaskLinkId(text) {
    return /tasks\.google\.com\/task\/([\w-]+)/.exec(text ?? '')?.[1] ?? null
  }

  /**
   * A task time-blocked from Calendar (click an empty slot > Task, rather
   * than the Tasks app's own date/time picker -- see listTasks) gets a real
   * `eventType: "focusTime"` event on the primary calendar, whose
   * description links back to the task by the same id as its webViewLink.
   * That's the only place a task's real time of day actually lives.
   */
  async function findFocusTimeBlockStart(task) {
    const linkId = extractTaskLinkId(task?.webViewLink)
    if (!linkId) return null

    const params = new URLSearchParams({
      timeMin: new Date(Date.now() - 86400000).toISOString(),
      timeMax: new Date(Date.now() + 180 * 86400000).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      eventTypes: 'focusTime',
      maxResults: '250'
    })
    const data = await apiFetch(`${CALENDAR_API}/calendars/primary/events?${params}`)
    const blocks = (data.items ?? []).filter((ev) => extractTaskLinkId(ev.description) === linkId)
    if (blocks.length === 0) return null

    // Sorted ascending by orderBy=startTime -- prefer the next upcoming
    // block, but fall back to the most recent past one (the last in the
    // list) so a missed block still resolves to "start now" the same way a
    // plain past-due date does.
    const now = Date.now()
    const upcoming = blocks.find((ev) => Date.parse(ev.start?.dateTime ?? '') >= now)
    return (upcoming ?? blocks[blocks.length - 1]).start?.dateTime ?? null
  }

  /**
   * The effective due time for scheduleTaskStopwatch in main.js: a linked
   * Calendar focus-time block's real start time when one exists, else the
   * task's own (date-only) `due`.
   */
  async function resolveTaskDueAt(task) {
    const blockStart = await findFocusTimeBlockStart(task).catch((err) => {
      console.warn('[auth] focus-time block lookup failed:', err.message)
      return null
    })
    return blockStart ?? task?.due ?? null
  }

  /**
   * The reference third-party integration: mark a to-do complete when the
   * timer finishes. Swap the endpoint here for Todoist/Asana/Linear and the
   * rest of the app is unchanged.
   */
  async function completeTask(taskListId, taskId) {
    if (!taskListId || !taskId) throw new Error('A task list and task must be selected first.')
    const url = `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`
    return apiFetch(url, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', completed: new Date().toISOString() })
    })
  }

  /**
   * Wired to the engine's 'expired' event in main.js. Swallows its own errors
   * because a failed API call must never break the timer's own completion.
   */
  async function completeConfiguredTaskOnExpiry() {
    if (!store.get('autoCompleteTaskEnabled')) return { skipped: 'disabled' }
    const taskListId = store.get('taskListId')
    const taskId = store.get('taskId')
    if (!taskListId || !taskId) return { skipped: 'no_task_selected' }

    try {
      await completeTask(taskListId, taskId)
      // A completed task shouldn't stay selected for the next run.
      store.set('taskId', null)
      return { ok: true }
    } catch (err) {
      console.error('[auth] auto-complete failed:', err.message)
      return { ok: false, error: err.message }
    }
  }

  return {
    isConfigured,
    getStatus,
    beginAuth,
    handleOAuthCallback,
    signOut,
    listTaskLists,
    listTasks,
    completeTask,
    completeConfiguredTaskOnExpiry,
    resolveTaskDueAt
  }
}
