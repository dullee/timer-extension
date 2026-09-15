import { randomBytes } from 'node:crypto'
import { app, safeStorage } from 'electron'
import Store from 'electron-store'

export const OVERLAY_MODE = Object.freeze({
  FLOATING: 'floating',
  MINI: 'mini'
})

// Size while the pointer is over the overlay, controls included. Both modes
// drop their controls into a row *below* the clock rather than widening, so
// only the height grows -- sized for the worst case the clock can produce
// ("1:05:04"), so the fixed-width row never has to squeeze or overlap.
export const OVERLAY_SIZES = Object.freeze({
  [OVERLAY_MODE.FLOATING]: { width: 170, height: 100 },
  [OVERLAY_MODE.MINI]: { width: 330, height: 132 }
})

// Size while the pointer is elsewhere: the overlay hides its controls, so
// the window shrinks to just the clock (and, in mini, the label) rather than
// leaving dead space where the buttons would have been.
export const OVERLAY_COMPACT_SIZES = Object.freeze({
  [OVERLAY_MODE.FLOATING]: { width: 170, height: 64 },
  [OVERLAY_MODE.MINI]: { width: 330, height: 90 }
})

const schema = {
  lastDurationMs: { type: 'number', minimum: 1000, default: 25 * 60 * 1000 },
  lastLabel: { type: 'string', default: '' },
  overlayMode: {
    type: 'string',
    enum: [OVERLAY_MODE.FLOATING, OVERLAY_MODE.MINI],
    default: OVERLAY_MODE.FLOATING
  },
  overlayPosition: {
    type: ['object', 'null'],
    default: null,
    properties: { x: { type: 'number' }, y: { type: 'number' } }
  },
  alwaysOnTop: { type: 'boolean', default: true },
  showOverlayOnStart: { type: 'boolean', default: true },
  volume: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
  soundEnabled: { type: 'boolean', default: true },
  notificationsEnabled: { type: 'boolean', default: true },
  preferredPort: { type: 'number', minimum: 1024, maximum: 65535, default: 3000 },
  apiToken: { type: 'string', default: '' },
  // Google integration
  googleTokens: { type: ['string', 'null'], default: null }, // encrypted blob
  googleTokensPlain: { type: ['object', 'null'], default: null }, // fallback
  googleAccountEmail: { type: ['string', 'null'], default: null },
  autoCompleteTaskEnabled: { type: 'boolean', default: false },
  taskListId: { type: ['string', 'null'], default: null },
  taskId: { type: ['string', 'null'], default: null }
}

export const store = new Store({ name: 'settings', schema })

/**
 * The API token is generated once on first run and then lives in settings.
 * 32 random bytes is far beyond what a localhost-bound service needs, but it
 * costs nothing and means the value is safe to paste around.
 */
export function ensureApiToken() {
  let token = store.get('apiToken')
  if (!token) {
    token = randomBytes(32).toString('hex')
    store.set('apiToken', token)
  }
  return token
}

export function regenerateApiToken() {
  const token = randomBytes(32).toString('hex')
  store.set('apiToken', token)
  return token
}

/* --------------------------------------------------------- token storage */

/**
 * OAuth tokens go through Electron's safeStorage, which is backed by the OS
 * keychain (DPAPI on Windows, Keychain on macOS).
 *
 * Note that electron-store's own `encryptionKey` option is NOT a substitute:
 * it ships the key inside the app, so it only obscures the file against casual
 * inspection. Refresh tokens deserve better than obfuscation.
 */
export function saveGoogleTokens(tokens) {
  if (tokens == null) {
    store.set('googleTokens', null)
    store.set('googleTokensPlain', null)
    return
  }

  const json = JSON.stringify(tokens)
  if (safeStorage.isEncryptionAvailable()) {
    store.set('googleTokens', safeStorage.encryptString(json).toString('base64'))
    store.set('googleTokensPlain', null)
  } else {
    // Happens on Linux without a keyring daemon. Degrade rather than fail,
    // but the Settings UI surfaces this so it isn't a silent downgrade.
    store.set('googleTokens', null)
    store.set('googleTokensPlain', tokens)
  }
}

export function loadGoogleTokens() {
  const encrypted = store.get('googleTokens')
  if (encrypted) {
    try {
      const buf = Buffer.from(encrypted, 'base64')
      return JSON.parse(safeStorage.decryptString(buf))
    } catch (err) {
      // Typically means the OS keychain entry is gone (different machine,
      // restored profile). Treat as signed out instead of crashing at boot.
      console.warn('[store] could not decrypt saved Google tokens:', err.message)
      store.set('googleTokens', null)
      return null
    }
  }
  return store.get('googleTokensPlain') ?? null
}

export function isTokenStorageEncrypted() {
  return safeStorage.isEncryptionAvailable()
}

export function clearGoogleAuth() {
  saveGoogleTokens(null)
  store.set('googleAccountEmail', null)
  store.set('taskListId', null)
  store.set('taskId', null)
  store.set('autoCompleteTaskEnabled', false)
}

/* ------------------------------------------------------------- settings */

/** The settings blob handed to the renderer. Never includes OAuth tokens. */
export function getPublicSettings() {
  return {
    lastDurationMs: store.get('lastDurationMs'),
    lastLabel: store.get('lastLabel'),
    overlayMode: store.get('overlayMode'),
    alwaysOnTop: store.get('alwaysOnTop'),
    showOverlayOnStart: store.get('showOverlayOnStart'),
    volume: store.get('volume'),
    soundEnabled: store.get('soundEnabled'),
    notificationsEnabled: store.get('notificationsEnabled'),
    preferredPort: store.get('preferredPort'),
    apiToken: store.get('apiToken'),
    googleAccountEmail: store.get('googleAccountEmail'),
    autoCompleteTaskEnabled: store.get('autoCompleteTaskEnabled'),
    taskListId: store.get('taskListId'),
    taskId: store.get('taskId'),
    tokenStorageEncrypted: isTokenStorageEncrypted(),
    appVersion: app.getVersion(),
    userDataPath: app.getPath('userData')
  }
}

const WRITABLE_SETTINGS = new Set([
  'lastDurationMs',
  'lastLabel',
  'overlayMode',
  'alwaysOnTop',
  'showOverlayOnStart',
  'volume',
  'soundEnabled',
  'notificationsEnabled',
  'preferredPort',
  'autoCompleteTaskEnabled',
  'taskListId',
  'taskId'
])

/** Allowlisted writes -- the renderer cannot reach tokens or arbitrary keys. */
export function updateSettings(patch = {}) {
  for (const [key, value] of Object.entries(patch)) {
    if (WRITABLE_SETTINGS.has(key)) store.set(key, value)
  }
  return getPublicSettings()
}
