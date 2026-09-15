import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Notification, app, ipcMain, nativeTheme, screen, shell } from 'electron'
import { MODE, STATE, TimerEngine } from './timer-engine.js'
import {
  OVERLAY_COMPACT_SIZES,
  OVERLAY_COMPACT_SIZES_WITH_RING,
  OVERLAY_MODE,
  OVERLAY_SIZES,
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

/**
 * The pointer starts outside the overlay, so it opens at its compact size.
 * The hover-expanded size doesn't depend on the ring -- it's already sized
 * for the five-button control row, which is wider than ring+clock either
 * way -- but the compact size is sized tightly around the clock alone, so it
 * needs the wider variant whenever the ring is also showing.
 */
function getOverlaySize(mode, hovered) {
  if (isDev) {
    const override = devOverlaySizeOverrides.get(devSizeKey(mode, hovered))
    if (override) return override
  }
  const sizes = hovered
    ? OVERLAY_SIZES
    : store.get('showProgressRing')
      ? OVERLAY_COMPACT_SIZES_WITH_RING
      : OVERLAY_COMPACT_SIZES
  return sizes[mode] ?? sizes[OVERLAY_MODE.FLOATING]
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
    if (store.get('showOverlayOnStart')) overlayWindow.show()
  })

  // Windows' native window-drag already refuses to let a caption-style drag
  // (which is what -webkit-app-region: drag triggers) move the top edge
  // above the screen, but it does nothing for the other three edges. Using
  // 'move' (after the fact) still lets a frame or two render off-screen
  // before the snap-back catches up, so intercept 'will-move' instead and
  // substitute the clamped bounds before the move ever happens -- the
  // window can then never actually leave the screen, on any edge.
  overlayWindow.on('will-move', (event, newBounds) => {
    const { workArea } = screen.getDisplayMatching(newBounds)
    const x = Math.min(Math.max(newBounds.x, workArea.x), workArea.x + workArea.width - newBounds.width)
    const y = Math.min(Math.max(newBounds.y, workArea.y), workArea.y + workArea.height - newBounds.height)
    if (x !== newBounds.x || y !== newBounds.y) {
      event.preventDefault()
      overlayWindow.setBounds({ x, y, width: newBounds.width, height: newBounds.height })
    }
  })

  // Remember where the user parked the widget.
  const savePosition = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const [x, y] = overlayWindow.getPosition()
    store.set('overlayPosition', { x, y })
  }
  overlayWindow.on('moved', savePosition)

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

// How long the compact <-> expanded resize takes to settle. Short enough
// that hovering still feels responsive, long enough to read as a glide
// rather than a snap.
const RESIZE_ANIMATION_MS = 180

let resizeAnimation = null

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
 */
function animateOverlayTo(size) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  // A resize that arrives mid-animation (rapid hover in/out) always
  // redirects from the window's actual current position rather than
  // queuing behind or fighting the one already in flight -- the same feel
  // as interrupting a CSS transition with a new target value.
  if (resizeAnimation) {
    clearInterval(resizeAnimation)
    resizeAnimation = null
  }

  const { x, y, width: fromWidth, height: fromHeight } = overlayWindow.getBounds()
  const { width: toWidth, height: toHeight } = size
  if (fromWidth === toWidth && fromHeight === toHeight) return

  overlayWindow.setResizable(true)

  const startedAt = Date.now()
  const easeOutCubic = (t) => 1 - (1 - t) ** 3

  resizeAnimation = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      clearInterval(resizeAnimation)
      resizeAnimation = null
      return
    }

    const t = Math.min(1, (Date.now() - startedAt) / RESIZE_ANIMATION_MS)
    const eased = easeOutCubic(t)

    overlayWindow.setBounds(
      {
        x,
        y,
        width: Math.round(fromWidth + (toWidth - fromWidth) * eased),
        height: Math.round(fromHeight + (toHeight - fromHeight) * eased)
      },
      false
    )

    if (t >= 1) {
      clearInterval(resizeAnimation)
      resizeAnimation = null
      overlayWindow.setResizable(false)
    }
  }, 1000 / 60)
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
 */
let overlayHovered = false
function pollOverlayHover() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) {
    overlayHovered = false
    return
  }

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

function wireEngine() {
  engine.on('state', (snapshot) => {
    broadcast('timer:state', snapshot)
    updateProgress(snapshot)
    tray?.refresh()
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

app.on('will-quit', async (event) => {
  if (!server) return
  event.preventDefault()
  const closing = server
  server = null
  try {
    await closing.close()
  } catch {
    // Nothing useful to do during shutdown.
  }
  engine.dispose()
  tray?.destroy()
  app.quit()
})
