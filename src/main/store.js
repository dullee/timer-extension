import { randomBytes } from 'node:crypto'
import { app, safeStorage } from 'electron'
import Store from 'electron-store'

export const OVERLAY_MODE = Object.freeze({
  FLOATING: 'floating',
  MINI: 'mini'
})

// The third design-tokens location, alongside src/renderer/styles.css
// (colors, shape, density, type scale) and src/renderer/lib/theme.js (ring
// sizes) -- window pixel dimensions have to live here specifically because
// they're passed to BrowserWindow in the main process, which has no access
// to the renderer's CSS. All three files cross-reference each other.
//
// Mini is the small, icon-only widget; floating is the larger one with a
// label and full-width transport buttons -- floating "floats fuller" is the
// mnemonic, if the names ever feel arbitrary. (They're just the two
// enum values; nothing stops you renaming them if you want the names
// themselves to say big/small -- see Overlay.jsx's `isMini` for the one
// other place that would need to follow.)
//
// Size while the pointer is over the overlay, controls included. Both modes
// drop their controls into a row *below* the clock rather than widening, so
// only the height grows -- sized for the worst case the clock can produce
// ("1:05:04"), so the fixed-width row never has to squeeze or overlap.
//
// Mini's width is specifically sized to its button row, not the clock text:
// measured directly, the row's 4 icon buttons (toggle mode / Settings /
// Close, plus Play-or-Pause) come to 102px of actual content (24px each +
// 3x 2px gaps), and the card's own padding here is 24px total -- 126px is
// the floor below which that row would clip. 134px leaves a real but
// deliberately thin 8px margin, well down from the original 170px, which
// was sized for a wider 5-button row before Dev Layout and the mode-switch
// button were removed from it.
export const OVERLAY_SIZES = Object.freeze({
  [OVERLAY_MODE.FLOATING]: { width: 330, height: 132 },
  [OVERLAY_MODE.MINI]: { width: 100, height: 80 }
})

// Size while the pointer is elsewhere: the overlay hides its controls, so
// the window shrinks to just the clock (and, in floating, the label) rather
// than leaving dead space where the buttons would have been. Width is sized
// to the worst case the clock can produce ("1:05:04"), measured against the
// actual rendered font at each mode's clock size (text-2xl / text-base) plus
// the card's px-3 padding -- not the wider hover-state width, which only has
// to be that wide to fit mini's button row, something the compact state
// never shows.
export const OVERLAY_COMPACT_SIZES = Object.freeze({
  [OVERLAY_MODE.FLOATING]: { width: 135, height: 90 },
  // Tighter than a straight worst-case-text calculation would need, on
  // purpose -- with the top row's content centered (see Overlay.jsx), the
  // gap from window edge to clock is (windowWidth - contentWidth) / 2
  // regardless of the card's own padding, so this width is the actual knob
  // for "how much breathing room the compact mini widget has."
  //
  // Measured, not guessed: the worst-case clock string ("1:05:04") renders
  // at 66x16px in mini's font, and the card's own horizontal padding here
  // is 12px total -- 78px is the hard floor below which that text clips.
  // 80x36 leaves a deliberately thin 2px/10px margin rather than the
  // original 84x54's more generous one, for a visibly smaller idle widget.
  [OVERLAY_MODE.MINI]: { width: 80, height: 36 }
})

// Same as above, but with room for the progress ring -- it's off by default
// (see `showProgressRing`), but when it's on it sits to the left of the
// clock and needs its own diameter plus the gap-2 between them accounted
// for, or it would get clipped at the narrower default compact width.
export const OVERLAY_COMPACT_SIZES_WITH_RING = Object.freeze({
  [OVERLAY_MODE.FLOATING]: { width: 185, height: 90 },
  [OVERLAY_MODE.MINI]: { width: 128, height: 44 }
})

// The floor width mini needs -- at *either* the compact or hover height --
// while the click-to-edit duration field (Overlay.jsx) is open, or while
// double-digit hours are simply showing (">=10h", read-only or not): both
// need all three H:MM:SS groups rendered at once, which every other mini
// size above was never sized for (they all assume the single-digit-hour
// worst case "1:05:04" -- see OVERLAY_COMPACT_SIZES's comment). main.js's
// getOverlaySize() takes the max of this and whatever the mode/hover state
// would otherwise use, so it only ever widens, never shrinks something that
// was already bigger for another reason (the hover width's button row,
// say). Floating has no equivalent entry: its own sizes (135-330px) already
// clear double-digit hours at its smaller text-base clock with room to
// spare, so it never needs widening.
export const OVERLAY_WIDE_WIDTHS = Object.freeze({
  [OVERLAY_MODE.MINI]: 165
})

const schema = {
  lastDurationMs: { type: 'number', minimum: 1000, default: 25 * 60 * 1000 },
  lastLabel: { type: 'string', default: '' },
  // Kept in lockstep with the live TimerEngine mode by setTimerMode() in
  // main.js (every path that can change it goes through that one function),
  // so this doubles as both "what the next run defaults to" and "what's
  // running right now" -- the same relationship overlayMode already has to
  // the overlay window's live size.
  lastMode: { type: 'string', enum: ['timer', 'stopwatch'], default: 'stopwatch' },
  overlayMode: {
    type: 'string',
    enum: [OVERLAY_MODE.FLOATING, OVERLAY_MODE.MINI],
    default: OVERLAY_MODE.MINI
  },
  overlayPosition: {
    type: ['object', 'null'],
    default: null,
    properties: { x: { type: 'number' }, y: { type: 'number' } }
  },
  alwaysOnTop: { type: 'boolean', default: true },
  showOverlayOnStart: { type: 'boolean', default: true },
  showProgressRing: { type: 'boolean', default: false },
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
    lastMode: store.get('lastMode'),
    overlayMode: store.get('overlayMode'),
    alwaysOnTop: store.get('alwaysOnTop'),
    showOverlayOnStart: store.get('showOverlayOnStart'),
    showProgressRing: store.get('showProgressRing'),
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
    userDataPath: app.getPath('userData'),
    // Computed, never persisted -- gates the dev-only Layout window and its
    // toggle button. A packaged install is never "not packaged," so this is
    // always false in anything a user actually installs.
    isDev: !app.isPackaged
  }
}

const WRITABLE_SETTINGS = new Set([
  'lastDurationMs',
  'lastLabel',
  'lastMode',
  'overlayMode',
  'alwaysOnTop',
  'showOverlayOnStart',
  'showProgressRing',
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
