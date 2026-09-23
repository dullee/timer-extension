import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Notification, app, ipcMain, nativeTheme, screen, shell } from 'electron'

// A Writable stream throws an uncaught exception on a write failure unless
// something is listening for its own 'error' event -- and nothing was, so a
// single failed console.log/console.error (stdout/stderr going briefly EIO,
// e.g. a dev terminal window being resized or its scrollback paused) was
// enough to crash the entire app, not just drop that one line of output. A
// dropped log line is fine; losing the whole GUI over it is not, so make
// these non-fatal instead of letting Node's default (fatal) behavior stand.
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE' && err.code !== 'EIO') throw err
})
process.stderr.on('error', (err) => {
  if (err.code !== 'EPIPE' && err.code !== 'EIO') throw err
})
import { MODE, STATE, TimerEngine } from './timer-engine.js'
import {
  OVERLAY_COMPACT_SIZES,
  OVERLAY_COMPACT_SIZES_WITH_RING,
  OVERLAY_MODE,
  OVERLAY_SIZES,
  OVERLAY_WIDE_WIDTHS,
  getPublicSettings,
  regenerateApiToken,
  store,
  updateSettings
} from './store.js'
import { startServer } from './server.js'
import { createGoogleAuth } from './auth.js'
import { createTray } from './tray.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// Must be set before any window exists, or Windows silently drops every
// notification we raise -- toasts are keyed to the AppUserModelID.
app.setAppUserModelId('com.dulle.timerdesktop')

/* ------------------------------------------------------------ singleton */

// A second launch must not bind another port or spawn a rival overlay.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

/* ---------------------------------------------------------------- state */

let overlayWindow = null
let settingsWindow = null
let devLayoutWindow = null // dev builds only -- see createDevLayoutWindow
let tray = null
let server = null
let auth = null
let isQuitting = false

const engine = new TimerEngine({
  defaultDurationMs: store.get('lastDurationMs'),
  defaultMode: store.get('lastMode')
})

/**
 * The one place that changes the timer's mode, used by the IPC handler, the
 * settings:update special-case, and the tray's Mode submenu alike -- so
 * store.lastMode and the live engine mode can never drift apart.
 */
function setTimerMode(mode) {
  // setMode() validates (throws RangeError for anything else) before this
  // persists it -- an invalid value must never reach the store, or it'd be
  // the default engine.getState() hands back on the next launch.
  const snapshot = engine.setMode(mode)
  store.set('lastMode', mode)
  return snapshot
}

/* -------------------------------------------------------------- windows */

/** In dev electron-vite serves the renderer; packaged we load the built file. */
function loadRenderer(win, hash) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    win.loadURL(`${devUrl}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

const sharedWebPreferences = {
  preload: join(__dirname, '../preload/preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  // Without this the chime never plays: when the REST API starts a timer
  // there has been no user gesture in the overlay, so Chromium's autoplay
  // policy blocks Audio.play() outright.
  autoplayPolicy: 'no-user-gesture-required'
}

// Dev-only window-size overrides, keyed by `${mode}-compact`/`${mode}-hover`.
// Deliberately in-memory only (resets on relaunch) rather than persisted --
// this is a developer actively iterating within a session, not a user
// preference, and it keeps the dev feature from needing its own store file.
// Never populated outside a dev build: the IPC handlers that write to it are
// only registered when isDev (see registerDevIpc), so there's no surface for
// a packaged app to reach this at all.
const devOverlaySizeOverrides = new Map()
const devSizeKey = (mode, hovered) => `${mode}-${hovered ? 'hover' : 'compact'}`

// Set by the 'window:set-overlay-editing-duration' IPC handler -- see
// setOverlayEditingDuration below -- whenever Overlay.jsx's click-to-edit
// duration field is open. In-memory only, like overlayHovered: this is
// live UI state, not something that should survive a relaunch.
let overlayEditingDuration = false

/**
 * Whether the overlay needs OVERLAY_WIDE_WIDTHS' floor instead of its
 * mode/hover size as normal: either the duration field is actively open, or
 * the clock is simply displaying 10+ hours already (checked off whatever
 * getState() currently has on the clock -- remainingMs doubles as "the
 * stopwatch's elapsed time" in that mode too, see timer-engine.js).
 */
function overlayNeedsWideWidth() {
  if (overlayEditingDuration) return true
  const { remainingMs } = engine.getState()
  return Math.floor(Math.max(0, remainingMs) / 3600000) >= 10
}

/**
 * The pointer starts outside the overlay, so it opens at its compact size.
 * The hover-expanded size doesn't depend on the ring -- it's already sized
 * for the five-button control row, which is wider than ring+clock either
 * way -- but the compact size is sized tightly around the clock alone, so it
 * needs the wider variant whenever the ring is also showing.
 */
function getOverlaySize(mode, hovered) {
  let base = null
  if (isDev) {
    base = devOverlaySizeOverrides.get(devSizeKey(mode, hovered)) ?? null
  }
  if (!base) {
    const sizes = hovered
      ? OVERLAY_SIZES
      : store.get('showProgressRing')
        ? OVERLAY_COMPACT_SIZES_WITH_RING
        : OVERLAY_COMPACT_SIZES
    base = sizes[mode] ?? sizes[OVERLAY_MODE.FLOATING]
  }
  // Applied even on top of a dev override -- a Dev Layout size is "what
  // this mode/hover state normally is," not "never widen this window for
  // any reason," and the duration field still needs its floor regardless
  // of whatever's being tuned.
  const wideWidth = OVERLAY_WIDE_WIDTHS[mode]
  if (wideWidth && overlayNeedsWideWidth()) {
    return { width: Math.max(base.width, wideWidth), height: base.height }
  }
  return base
}

/**
 * Wired to the duration field's open/close state in Overlay.jsx. Resizes
 * immediately rather than waiting for the next hover/tick-driven resize --
 * opening the field should widen the window right then, not whenever
 * something else next happens to trigger a size check.
 */
function setOverlayEditingDuration(editing) {
  const next = Boolean(editing)
  if (next === overlayEditingDuration) return
  overlayEditingDuration = next
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    animateOverlayTo(getOverlaySize(store.get('overlayMode'), overlayHovered))
  }
}

function createOverlayWindow() {
  const mode = store.get('overlayMode')
  const size = getOverlaySize(mode, false)
  const savedPosition = store.get('overlayPosition')

  overlayWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: savedPosition ? savedPosition.x : 0,
    y: savedPosition ? savedPosition.y : 0,
    frame: false,
    transparent: true,
    // Transparent windows have long-standing resize artifacts on Windows, so
    // the overlay is fixed-size and mode switches drive setBounds instead.
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: sharedWebPreferences
  })

  applyAlwaysOnTop(store.get('alwaysOnTop'))
  loadRenderer(overlayWindow, '/overlay')

  overlayWindow.once('ready-to-show', () => {
    if (store.get('showOverlayOnStart')) {
      overlayWindow.show()
      // See showOverlay()'s comment on why this is reapplied on every show,
      // not just here at creation.
      applyAlwaysOnTop(store.get('alwaysOnTop'))
    }
  })

  // Windows' native window-drag already refuses to let a caption-style drag
  // (which is what -webkit-app-region: drag triggers) move the top edge
  // above the screen, but it does nothing for the other three edges. Using
  // 'move' (after the fact) still lets a frame or two render off-screen
  // before the snap-back catches up, so intercept 'will-move' instead and
  // substitute the clamped bounds before the move ever happens -- the
  // window can then never actually leave the screen, on any edge.
  //
  // That substitution only works on Windows, though: per Electron's own
  // docs, event.preventDefault() in this handler "will prevent the window
  // from being moved" on Windows specifically -- on macOS it's a no-op, the
  // native drag keeps driving the window to the raw (unclamped) newBounds
  // regardless. Calling setBounds() there anyway doesn't substitute
  // anything; it just races the OS's own in-progress move with our
  // correction on every tick, which is the glitching/jitter this produced
  // on macOS while staying perfectly smooth on Windows. So only do the
  // live clamp-and-cancel on win32; macOS instead gets clamped once,
  // cleanly, right after the drag settles (see the dragSettleTimer callback
  // in markDragging below) -- a soft correction instead of a fight.
  overlayWindow.on('will-move', (event, newBounds) => {
    // 'will-move' only ever fires for this kind of interactive, OS-driven
    // drag -- not for our own setBounds() calls -- so it doubles as a clean
    // "currently being dragged" signal. See markDragging below for why that
    // matters: the hover poll needs to go quiet for the whole drag, not
    // just react to whatever momentary detail is happening on each 100ms
    // tick.
    markDragging()

    if (process.platform !== 'win32') return

    const clamped = clampBoundsToWorkArea(newBounds)
    if (clamped.x !== newBounds.x || clamped.y !== newBounds.y) {
      event.preventDefault()
      overlayWindow.setBounds(clamped)
    }
  })

  // Remember where the user parked the widget.
  const savePosition = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const [x, y] = overlayWindow.getPosition()
    store.set('overlayPosition', { x, y })
  }
  overlayWindow.on('moved', () => {
    // 'will-move' (windowWillMove:) only fires once, at the very start of
    // an interactive drag on macOS -- unlike Windows' WM_MOVING, which
    // fires on every tick of the drag. Relying on will-move alone to hold
    // markDragging's freeze let it expire ~120ms into any mac drag that
    // outlasted that, well before the user actually let go: the hover poll
    // would resume mid-drag, see the cursor drift outside the window's
    // current bounds (routine during a fast drag), and fire a resize that
    // fights the OS's own drag-move -- the window desyncing from the
    // cursor / stuttering that will-move's freeze was meant to prevent.
    // 'moved' (windowDidMove:) does fire on every tick on both platforms,
    // so once a drag is under way (isDragging already true, set by
    // will-move) let it re-arm the same settle timer. Gated on isDragging
    // already being true so our own programmatic moves -- the edge-docked
    // animateOverlayTo() glide, the post-drag settle clamp -- don't
    // spuriously start a freeze of their own; those always land after
    // will-move's freeze has already lapsed.
    if (isDragging) markDragging()
    savePosition()
  })

  overlayWindow.on('close', (event) => {
    // Closing the widget hides it; the tray keeps the app reachable.
    if (!isQuitting) {
      event.preventDefault()
      overlayWindow.hide()
      tray?.refresh()
    }
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  return overlayWindow
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  settingsWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: 'Timer Settings',
    // Painted for one frame before the page's own CSS takes over, so it has
    // to guess the theme itself -- nativeTheme.shouldUseDarkColors reflects
    // the live OS setting, matching the surface tokens in styles.css.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    show: false,
    autoHideMenuBar: true,
    webPreferences: sharedWebPreferences
  })

  loadRenderer(settingsWindow, '/settings')
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  return settingsWindow
}

/**
 * Dev builds only -- see registerDevIpc, which is the only thing that can
 * ever call this. A packaged app never opens this window because nothing in
 * it is reachable: the IPC channel that triggers it simply isn't registered.
 */
function createDevLayoutWindow() {
  if (!isDev) return null
  if (devLayoutWindow && !devLayoutWindow.isDestroyed()) {
    devLayoutWindow.show()
    devLayoutWindow.focus()
    return devLayoutWindow
  }

  devLayoutWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 360,
    minHeight: 480,
    title: 'Dev Layout',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    show: false,
    autoHideMenuBar: true,
    webPreferences: sharedWebPreferences
  })

  loadRenderer(devLayoutWindow, '/dev-layout')
  devLayoutWindow.once('ready-to-show', () => devLayoutWindow.show())
  devLayoutWindow.on('closed', () => {
    devLayoutWindow = null
  })

  return devLayoutWindow
}

function applyAlwaysOnTop(value) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  // 'screen-saver' is the level that actually floats above fullscreen apps;
  // the default 'floating' level loses to them on macOS.
  overlayWindow.setAlwaysOnTop(Boolean(value), 'screen-saver')
  if (value) {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    overlayWindow.setVisibleOnAllWorkspaces(false)
  }
}

// How long the compact <-> expanded resize takes to settle, and how often it
// steps while doing so. 60fps was noticeably choppy for a resize this size
// (each step's width/height jump is large enough to see) -- 120fps halves
// the jump between steps for a visibly smoother glide. Slower on purpose too:
// 450ms reads as a deliberate glide rather than a quick snap, while still
// resolving well within the time it takes to actually move the mouse away.
const RESIZE_ANIMATION_MS = 450
const RESIZE_FPS = 120

let resizeAnimation = null

function lockOverlayResizable() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (process.platform === 'win32') overlayWindow.setResizable(false)
}

function unlockOverlayResizableForBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (process.platform === 'win32') overlayWindow.setResizable(true)
}

/**
 * Animates the overlay to `size`, growing or shrinking from wherever it
 * currently sits.
 *
 * setBounds() takes an `animate` flag, but that's macOS-only -- Windows and
 * Linux ignore it and just jump, which is what this replaces. Driving it by
 * hand with repeated setBounds() calls on an eased timeline looks the same
 * on every platform instead of smooth on one and instant on the other two.
 *
 * On Windows, a BrowserWindow created with resizable: false has its min/max
 * size locked to its creation size -- a later setBounds with a different
 * width/height updates Electron's internal bounds (and so the content
 * re-layouts to it) but the OS silently clamps the actual on-screen frame
 * back, since it's still constrained to that old min==max. Toggling
 * resizable once for the whole animation (not per frame, which would
 * flicker) forces Windows to accept the new size.
 *
 * That unlock is Windows-only: on macOS setBounds already works with
 * resizable: false, and flipping it true (even briefly) lets the user
 * drag the overlay's edges -- which Windows 11 never allows. Interruptions
 * that clear the interval before the final setResizable(false) could also
 * leave the window permanently resizable on macOS.
 */
/**
 * Stops any in-flight resize glide dead, without finishing it or queuing
 * anything behind it. animateOverlayTo() already does this itself when a
 * *new* target size interrupts the old one; this is the other caller --
 * see markDragging below -- for when a drag interrupts it instead. The
 * animation's own setInterval calls setBounds() up to 120x/sec, and every
 * one of those is exactly the "setBounds() during/near a live drag corrupts
 * the OS's own drag-tracking state" hazard the pollOverlayHover freeze
 * above already exists to avoid on macOS -- that freeze only stops *new*
 * hover-triggered resizes from starting mid-drag, though, it does nothing
 * for a resize that was already running the instant the drag began (hover
 * lands, then the user immediately grabs the still-animating widget), which
 * is exactly what left the window teleporting around under the cursor
 * instead of following it smoothly.
 */
function cancelResizeAnimation() {
  if (!resizeAnimation) return
  clearInterval(resizeAnimation)
  resizeAnimation = null
  // Only does anything on Windows (see animateOverlayTo's own comment on
  // why resizable is toggled at all) -- harmless to call unconditionally.
  lockOverlayResizable()
}

function animateOverlayTo(size) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  // A resize that arrives mid-animation (rapid hover in/out) always
  // redirects from the window's actual current position rather than
  // queuing behind or fighting the one already in flight -- the same feel
  // as interrupting a CSS transition with a new target value.
  cancelResizeAnimation()

  const { x, y, width: fromWidth, height: fromHeight } = overlayWindow.getBounds()
  const { width: toWidth, height: toHeight } = size
  if (fromWidth === toWidth && fromHeight === toHeight) return

  // If the window is flush against the screen's right and/or bottom edge,
  // keep that edge pinned as the size changes -- otherwise a resize always
  // keeps x/y fixed (see the interpolation below), which pins the *left*/
  // *top* edge instead and visibly detaches a right- or bottom-docked widget
  // from the edge it was parked against. Left/top docking needs no special
  // case: keeping x/y fixed is already exactly what pins those edges.
  // EDGE_TOLERANCE absorbs rounding -- the will-move handler above produces
  // an exact match when the user actually drags the window flush against an
  // edge.
  const EDGE_TOLERANCE = 2
  const { workArea } = screen.getDisplayMatching({ x, y, width: fromWidth, height: fromHeight })
  const dockedRight = x + fromWidth >= workArea.x + workArea.width - EDGE_TOLERANCE
  const dockedBottom = y + fromHeight >= workArea.y + workArea.height - EDGE_TOLERANCE
  const toX = dockedRight ? workArea.x + workArea.width - toWidth : x
  const toY = dockedBottom ? workArea.y + workArea.height - toHeight : y

  unlockOverlayResizableForBounds()

  const startedAt = Date.now()
  // Ease-in-out, not ease-out: ease-out moves *fastest at the very start*
  // and only decelerates into the landing, so everything that reflows with
  // the window -- especially the clock text, which re-centers every frame
  // as the row's width changes -- got a jarring high-speed burst right as
  // a hover began, before slowing down. Easing in gently at both ends
  // removes that burst without needing to touch the reflow itself.
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)

  resizeAnimation = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      clearInterval(resizeAnimation)
      resizeAnimation = null
      return
    }

    const t = Math.min(1, (Date.now() - startedAt) / RESIZE_ANIMATION_MS)
    const eased = easeInOutCubic(t)

    overlayWindow.setBounds(
      {
        // Animated on the same eased timeline as width/height so all four
        // finish together. A no-op (x === toX / y === toY) for an edge that
        // isn't docked -- only a right- or bottom-docked window actually
        // moves along that axis.
        x: Math.round(x + (toX - x) * eased),
        y: Math.round(y + (toY - y) * eased),
        width: Math.round(fromWidth + (toWidth - fromWidth) * eased),
        height: Math.round(fromHeight + (toHeight - fromHeight) * eased)
      },
      false
    )

    if (t >= 1) {
      clearInterval(resizeAnimation)
      resizeAnimation = null
      lockOverlayResizable()
    }
  }, 1000 / RESIZE_FPS)
  resizeAnimation.unref?.()
}

function setOverlayMode(mode) {
  if (!OVERLAY_SIZES[mode]) return store.get('overlayMode')
  store.set('overlayMode', mode)

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    animateOverlayTo(getOverlaySize(mode, overlayHovered))
  }

  broadcast('settings:changed', getPublicSettings())
  tray?.refresh()
  return mode
}

/**
 * -webkit-app-region: drag covers almost the whole overlay, and on Windows
 * that area is hit-tested as window chrome (HTCAPTION) -- the renderer never
 * gets mousemove/mouseenter/mouseleave there, only over the .no-drag
 * buttons. Polling the cursor against the window bounds sidesteps that, and
 * also drives the resize between the compact and full-controls sizes so the
 * hidden buttons don't just leave dead space behind.
 *
 * That resize is exactly what goes wrong during an actual drag: dragging
 * moves the window from under a cursor that mostly stays put relative to
 * the screen, so a fast or diagonal drag routinely puts the cursor outside
 * the window's own bounds for a tick or two even though the user is still
 * holding it -- not a real "mouse left the widget." Reacting to that by
 * shrinking mid-drag fights the OS's own drag-move for control of the same
 * window, which is the visible glitching, and can flip hover on and off
 * repeatedly as the shrink/grow itself shifts the window under the cursor.
 * The fix is to stop reacting to momentary cursor position at all while a
 * drag is in progress -- freeze the current hover/size entirely -- and
 * resolve it once, cleanly, right after the drag actually settles.
 */
let overlayHovered = false
let isDragging = false
let dragSettleTimer = null
// No further will-move/moved events for this long => the drag has ended.
// This has to clear the OS's own live-drag pauses, not just our polling
// cadence: a pause in cursor movement while the mouse button is still held
// -- routine on a trackpad, where users re-grip mid-gesture -- produces no
// 'moved' events either, since the window genuinely isn't moving yet. A
// threshold that's too short concludes the drag ended while it's still
// live, unfreezes, and lets pollOverlayHover's hover-triggered resize call
// setBounds() -- which is exactly what desyncs -webkit-app-region: drag's
// tracking from the cursor on macOS (a known Electron/AppKit interaction:
// setBounds() during/near a live drag corrupts the OS's own drag-tracking
// state), producing the window "teleporting" away from the mouse for the
// rest of that gesture.
const DRAG_SETTLE_IDLE_MS = 450

/** Keeps `bounds` fully within the work area of whichever display it's
 * (mostly) on -- shared by the live win32 will-move clamp above and the
 * post-drag settle clamp below. */
function clampBoundsToWorkArea(bounds) {
  const { workArea } = screen.getDisplayMatching(bounds)
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width)
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height)
  return { x, y, width: bounds.width, height: bounds.height }
}

/** Called from the overlay's 'will-move' handler, which only ever fires for
 * an interactive OS-driven drag -- never for our own setBounds() calls. */
function markDragging() {
  isDragging = true
  // See cancelResizeAnimation's own comment -- a resize that was already
  // running the instant this drag started needs to die right here, not
  // finish out its remaining frames fighting the drag for the next
  // (up to) 450ms.
  cancelResizeAnimation()
  if (dragSettleTimer) clearTimeout(dragSettleTimer)
  dragSettleTimer = setTimeout(() => {
    isDragging = false
    dragSettleTimer = null
    // macOS never got the live clamp during the drag itself (see will-move
    // above -- preventDefault() can't cancel the native move there), so the
    // window may have been let go past a screen edge. Correct that now,
    // once, instead of fighting the drag frame-by-frame.
    if (process.platform !== 'win32' && overlayWindow && !overlayWindow.isDestroyed()) {
      const clamped = clampBoundsToWorkArea(overlayWindow.getBounds())
      overlayWindow.setBounds(clamped)
    }
    // One clean, immediate resolution against the cursor's actual final
    // position, rather than waiting out the rest of the 100ms poll cycle.
    pollOverlayHover()
  }, DRAG_SETTLE_IDLE_MS)
}

function pollOverlayHover() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) {
    overlayHovered = false
    return
  }
  // Frozen for the whole drag -- see markDragging above.
  if (isDragging) return

  const { x, y } = screen.getCursorScreenPoint()
  const bounds = overlayWindow.getBounds()
  const inside = x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height

  if (inside !== overlayHovered) {
    overlayHovered = inside
    animateOverlayTo(getOverlaySize(store.get('overlayMode'), overlayHovered))
    overlayWindow.webContents.send('overlay:hover', overlayHovered)
  }
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow()
  overlayWindow.show()
  // macOS drops an NSWindow's "join all Spaces, including full-screen ones"
  // collection behavior across a hide/show cycle -- applyAlwaysOnTop's
  // setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) sticks
  // right after creation, but silently stops applying the next time the
  // window is hidden (tray toggle, the close button) and shown again,
  // which is what let the overlay vanish the moment another app went
  // fullscreen despite alwaysOnTop being on the whole time. Reapplying it
  // on every show, not just once at creation, is what makes it durable.
  applyAlwaysOnTop(store.get('alwaysOnTop'))
  tray?.refresh()
}

function toggleOverlayVisible() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide()
  } else {
    showOverlay()
  }
  tray?.refresh()
}

/* ----------------------------------------------------------- broadcast */

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Taskbar/Dock progress. Windows paints it into the taskbar button, macOS
 * into the Dock icon; -1 clears it.
 *
 * Timer mode only: "progress" implies progress toward something, and a
 * stopwatch has no target to measure against -- showing a fraction there
 * would just be elapsedMs racing past the last configured timer duration and
 * sticking at "full" forever, which is actively misleading rather than
 * merely unhelpful.
 */
function updateProgress(snapshot) {
  const target = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : overlayWindow
  if (!target || target.isDestroyed()) return

  const showsProgress =
    snapshot.mode === MODE.TIMER && (snapshot.state === STATE.RUNNING || snapshot.state === STATE.PAUSED)

  if (showsProgress) {
    const fraction = snapshot.durationMs > 0 ? snapshot.elapsedMs / snapshot.durationMs : 0
    target.setProgressBar(Math.min(1, Math.max(0, fraction)), {
      mode: snapshot.state === STATE.PAUSED ? 'paused' : 'normal'
    })
  } else {
    target.setProgressBar(-1)
  }
}

function notifyExpired(snapshot) {
  if (!store.get('notificationsEnabled')) return
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: 'Timer finished',
    body: snapshot.label ? `"${snapshot.label}" is done.` : 'Your timer has finished.',
    urgency: 'critical'
  })
  notification.on('click', () => showOverlay())
  notification.show()
}

/* ------------------------------------------------------------ IPC wiring */

function registerIpc() {
  ipcMain.handle('timer:get-state', () => engine.getState())

  ipcMain.handle('timer:start', (_e, payload = {}) => {
    // Let start() validate (it throws on a bad durationMs or mode) before
    // persisting anything, and bank what actually took effect -- see the
    // matching REST route in server.js for why this reads off the snapshot.
    const snapshot = engine.start(payload)
    store.set('lastDurationMs', snapshot.durationMs)
    if (payload?.label != null) store.set('lastLabel', String(payload.label))
    store.set('lastMode', snapshot.mode)
    return snapshot
  })

  ipcMain.handle('timer:pause', () => engine.pause())
  ipcMain.handle('timer:resume', () => engine.resume())
  ipcMain.handle('timer:toggle', () => engine.toggle())
  ipcMain.handle('timer:reset', () => engine.reset())
  ipcMain.handle('timer:set-mode', (_e, mode) => setTimerMode(mode))

  ipcMain.handle('timer:set-duration', (_e, durationMs) => {
    store.set('lastDurationMs', Math.round(Number(durationMs)))
    return engine.setDuration(durationMs)
  })

  ipcMain.handle('timer:set-label', (_e, label) => {
    store.set('lastLabel', label == null ? '' : String(label))
    return engine.setLabel(label)
  })

  ipcMain.handle('settings:get', () => getPublicSettings())

  ipcMain.handle('settings:update', (_e, patch = {}) => {
    const next = updateSettings(patch)
    if ('alwaysOnTop' in patch) applyAlwaysOnTop(patch.alwaysOnTop)
    if ('overlayMode' in patch) setOverlayMode(patch.overlayMode)
    if ('lastDurationMs' in patch) engine.setDuration(patch.lastDurationMs)
    if ('lastMode' in patch) setTimerMode(patch.lastMode)
    // The compact width depends on whether the ring is showing (see
    // getOverlaySize) -- resize now rather than waiting for the next hover
    // transition, or the window would sit at the old width until the user
    // happens to move the mouse over it.
    if ('showProgressRing' in patch && overlayWindow && !overlayWindow.isDestroyed()) {
      animateOverlayTo(getOverlaySize(store.get('overlayMode'), overlayHovered))
    }
    broadcast('settings:changed', next)
    tray?.refresh()
    return next
  })

  ipcMain.handle('settings:regenerate-token', () => {
    const token = regenerateApiToken()
    // The running server captured the old token at startup, so say so plainly
    // rather than pretending the change is already live.
    broadcast('settings:changed', getPublicSettings())
    return { token, restartRequired: true }
  })

  ipcMain.handle('server:info', () => ({
    port: server?.port ?? null,
    baseUrl: server?.baseUrl ?? null,
    discoveryPath: server?.discoveryPath ?? null
  }))

  ipcMain.handle('window:set-overlay-mode', (_e, mode) => setOverlayMode(mode))
  ipcMain.handle('window:set-overlay-editing-duration', (_e, editing) => setOverlayEditingDuration(editing))
  ipcMain.handle('window:hide-overlay', () => {
    overlayWindow?.hide()
    tray?.refresh()
  })
  ipcMain.handle('window:open-settings', () => {
    createSettingsWindow()
  })
  ipcMain.handle('window:close-settings', () => {
    settingsWindow?.close()
  })
  ipcMain.handle('window:set-always-on-top', (_e, value) => {
    store.set('alwaysOnTop', Boolean(value))
    applyAlwaysOnTop(value)
    broadcast('settings:changed', getPublicSettings())
    return Boolean(value)
  })

  ipcMain.handle('shell:open-external', (_e, url) => {
    // Only ever hand http(s) to the OS -- other schemes can launch programs.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url)
    return null
  })

  ipcMain.handle('google:status', () => auth.getStatus())
  ipcMain.handle('google:connect', () => auth.beginAuth())
  ipcMain.handle('google:disconnect', () => auth.signOut())
  ipcMain.handle('google:list-task-lists', () => auth.listTaskLists())
  ipcMain.handle('google:list-tasks', (_e, taskListId) => auth.listTasks(taskListId))
}

/**
 * Only called when isDev -- a packaged app never registers these channels at
 * all, not even disabled ones, so `ipcRenderer.invoke('dev:...')` from a
 * shipped build simply fails with "no handler registered" rather than
 * reaching anything.
 */
function registerDevIpc() {
  ipcMain.handle('window:open-dev-layout', () => {
    createDevLayoutWindow()
  })

  ipcMain.handle('dev:get-overlay-size-overrides', () => Object.fromEntries(devOverlaySizeOverrides))

  ipcMain.handle('dev:set-overlay-size-override', (_e, { mode, hovered, size } = {}) => {
    const key = devSizeKey(mode, hovered)
    if (size) devOverlaySizeOverrides.set(key, size)
    else devOverlaySizeOverrides.delete(key)

    // Live preview: only worth an immediate resize if the override that just
    // changed is the one actually on screen right now.
    if (
      overlayWindow &&
      !overlayWindow.isDestroyed() &&
      store.get('overlayMode') === mode &&
      overlayHovered === hovered
    ) {
      animateOverlayTo(getOverlaySize(mode, hovered))
    }

    return Object.fromEntries(devOverlaySizeOverrides)
  })

  ipcMain.handle('dev:reset-overlay-size-overrides', () => {
    devOverlaySizeOverrides.clear()
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      animateOverlayTo(getOverlaySize(store.get('overlayMode'), overlayHovered))
    }
  })
}

/* --------------------------------------------------------------- engine */

/**
 * Re-checks whether mini's wide width should still apply now that the
 * clock's value has changed -- crossing the 10-hour mark, either direction,
 * while running/counting. animateOverlayTo() already no-ops when the target
 * size matches the current one (see its own early return), so calling this
 * on every single tick is cheap: it's a real resize only on the rare second
 * that boundary is actually crossed, same eased glide as every other
 * overlay resize.
 */
function syncOverlaySizeToTimer() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    animateOverlayTo(getOverlaySize(store.get('overlayMode'), overlayHovered))
  }
}

function wireEngine() {
  engine.on('state', (snapshot) => {
    broadcast('timer:state', snapshot)
    updateProgress(snapshot)
    tray?.refresh()
    syncOverlaySizeToTimer()
  })

  // Rebuilding the tray menu 5x a second is pointless work; the visible
  // countdown only changes once a second.
  let lastTraySecond = -1
  engine.on('tick', (snapshot) => {
    broadcast('timer:state', snapshot)
    updateProgress(snapshot)
    const second = Math.ceil(snapshot.remainingMs / 1000)
    if (second !== lastTraySecond) {
      lastTraySecond = second
      tray?.refresh()
    }
    syncOverlaySizeToTimer()
  })

  engine.on('expired', async (snapshot) => {
    // Bring the widget forward so the chime has something to belong to.
    showOverlay()
    broadcast('timer:expired', snapshot)
    notifyExpired(snapshot)

    const result = await auth.completeConfiguredTaskOnExpiry()
    if (result?.ok) broadcast('settings:changed', getPublicSettings())
  })
}

/* ----------------------------------------------------------- app lifecycle */

app.on('second-instance', () => {
  showOverlay()
  createSettingsWindow()
})

app.whenReady().then(async () => {
  auth = createGoogleAuth({
    getPort: () => server?.port ?? null,
    onChange: (status) => broadcast('google:status-changed', status)
  })

  try {
    server = await startServer({ engine, auth })
  } catch (err) {
    // The GUI is still perfectly usable without the API, so log loudly and
    // carry on rather than refusing to start.
    console.error('[main] failed to start local API server:', err.message)
  }

  registerIpc()
  if (isDev) registerDevIpc()
  wireEngine()
  createOverlayWindow()
  setInterval(pollOverlayHover, 100)

  tray = createTray({
    engine,
    controls: {
      getOverlayMode: () => store.get('overlayMode'),
      setOverlayMode,
      setTimerMode,
      isOverlayVisible: () =>
        Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),
      toggleOverlayVisible,
      openSettings: createSettingsWindow,
      quit: () => {
        isQuitting = true
        app.quit()
      }
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow()
    else showOverlay()
  })
})

// The tray is the app's real home, so closing every window is not a quit.
app.on('window-all-closed', () => {
  // Intentionally empty -- quitting happens through the tray's Quit item.
})

app.on('before-quit', () => {
  isQuitting = true
})

let hasCleanedUpForQuit = false

app.on('will-quit', async (event) => {
  // engine.dispose() and tray.destroy() used to live inside the `if
  // (!server)` branch below, so they never ran at all when the local API
  // server had failed to start (see the startServer() catch in
  // whenReady() -- the app carries on without it rather than refusing to
  // launch). With no dispose(), the engine's tick interval kept firing
  // during quit teardown, and its 'tick'/'state' handlers (wireEngine)
  // kept calling tray.refresh() after Electron had already torn down the
  // native tray -- an uncaught "Tray is destroyed". Guard with a flag
  // instead of `server` so cleanup always runs exactly once regardless of
  // whether the server ever came up.
  if (hasCleanedUpForQuit) return
  hasCleanedUpForQuit = true
  event.preventDefault()

  engine.dispose()
  tray?.destroy()
  tray = null

  if (server) {
    const closing = server
    server = null
    try {
      await closing.close()
    } catch {
      // Nothing useful to do during shutdown.
    }
  }

  app.quit()
})
