import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Notification, app, ipcMain, screen, shell } from 'electron'
import { STATE, TimerEngine } from './timer-engine.js'
import {
  OVERLAY_COMPACT_SIZES,
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
let tray = null
let server = null
let auth = null
let isQuitting = false

const engine = new TimerEngine({ defaultDurationMs: store.get('lastDurationMs') })

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

/** The pointer starts outside the overlay, so it opens at its compact size. */
function getOverlaySize(mode, hovered) {
  const sizes = hovered ? OVERLAY_SIZES : OVERLAY_COMPACT_SIZES
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
    backgroundColor: '#0f172a',
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

/**
 * On Windows, a BrowserWindow created with resizable: false has its min/max
 * size locked to its creation size -- a later setBounds with a different
 * width/height updates Electron's internal bounds (and so the content
 * re-layouts to it) but the OS silently clamps the actual on-screen frame
 * back, since it's still constrained to that old min==max. Toggling
 * resizable around the call forces Windows to accept the new size.
 */
function resizeOverlayTo(size) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const { x, y } = overlayWindow.getBounds()
  overlayWindow.setResizable(true)
  overlayWindow.setBounds({ x, y, width: size.width, height: size.height }, false)
  overlayWindow.setResizable(false)
}

function setOverlayMode(mode) {
  if (!OVERLAY_SIZES[mode]) return store.get('overlayMode')
  store.set('overlayMode', mode)

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    resizeOverlayTo(getOverlaySize(mode, overlayHovered))
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
    resizeOverlayTo(getOverlaySize(store.get('overlayMode'), overlayHovered))
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
 */
function updateProgress(snapshot) {
  const target = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : overlayWindow
  if (!target || target.isDestroyed()) return

  if (snapshot.state === STATE.RUNNING || snapshot.state === STATE.PAUSED) {
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
    if (payload?.durationMs) store.set('lastDurationMs', Math.round(Number(payload.durationMs)))
    if (payload?.label != null) store.set('lastLabel', String(payload.label))
    return engine.start(payload)
  })

  ipcMain.handle('timer:pause', () => engine.pause())
  ipcMain.handle('timer:resume', () => engine.resume())
  ipcMain.handle('timer:toggle', () => engine.toggle())
  ipcMain.handle('timer:reset', () => engine.reset())

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
  wireEngine()
  createOverlayWindow()
  setInterval(pollOverlayHover, 100)

  tray = createTray({
    engine,
    controls: {
      getOverlayMode: () => store.get('overlayMode'),
      setOverlayMode,
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
