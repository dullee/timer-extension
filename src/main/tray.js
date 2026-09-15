import { join } from 'node:path'
import { Menu, Tray, app, nativeImage } from 'electron'
import { STATE } from './timer-engine.js'
import { OVERLAY_MODE } from './store.js'

function formatRemaining(ms) {
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function trayIcon() {
  // In dev the icon sits in the repo; packaged it rides along in resources.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png'), join(app.getAppPath(), 'build', 'icon.png')]
    : [join(app.getAppPath(), 'build', 'icon.png')]

  for (const path of candidates) {
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) {
      // macOS wants a small template-sized icon; Windows scales 16px fine.
      return image.resize({ width: 16, height: 16 })
    }
  }
  return nativeImage.createEmpty()
}

/**
 * System tray icon with quick controls.
 *
 * The tray is what makes the overlay's close button safe to treat as "hide":
 * there is always a visible way back to the app and an explicit Quit, so
 * dismissing the widget never strands a running timer in the background.
 */
export function createTray({ engine, controls }) {
  const tray = new Tray(trayIcon())

  function build() {
    const { state, remainingMs, label } = engine.getState()
    const running = state === STATE.RUNNING
    const paused = state === STATE.PAUSED
    const overlayMode = controls.getOverlayMode()

    const status =
      state === STATE.IDLE
        ? 'Ready'
        : state === STATE.EXPIRED
          ? 'Finished'
          : `${formatRemaining(remainingMs)}${paused ? ' (paused)' : ''}`

    const menu = Menu.buildFromTemplate([
      { label: label ? `${label} — ${status}` : status, enabled: false },
      { type: 'separator' },
      {
        label: running ? 'Pause' : paused ? 'Resume' : 'Start',
        click: () => engine.toggle()
      },
      { label: 'Reset', enabled: state !== STATE.IDLE, click: () => engine.reset() },
      { type: 'separator' },
      {
        label: 'Show overlay',
        type: 'checkbox',
        checked: controls.isOverlayVisible(),
        click: () => controls.toggleOverlayVisible()
      },
      {
        label: 'Overlay size',
        submenu: [
          {
            label: 'Floating (compact)',
            type: 'radio',
            checked: overlayMode === OVERLAY_MODE.FLOATING,
            click: () => controls.setOverlayMode(OVERLAY_MODE.FLOATING)
          },
          {
            label: 'Mini (expanded)',
            type: 'radio',
            checked: overlayMode === OVERLAY_MODE.MINI,
            click: () => controls.setOverlayMode(OVERLAY_MODE.MINI)
          }
        ]
      },
      { type: 'separator' },
      { label: 'Settings…', click: () => controls.openSettings() },
      { type: 'separator' },
      { label: 'Quit Timer', click: () => controls.quit() }
    ])

    tray.setContextMenu(menu)
    tray.setToolTip(state === STATE.IDLE ? 'Timer' : `Timer — ${status}`)
  }

  build()

  // Clicking the icon itself is the fast path to showing the widget again.
  tray.on('click', () => controls.toggleOverlayVisible())
  tray.on('double-click', () => controls.openSettings())

  return {
    refresh: build,
    destroy: () => tray.destroy()
  }
}
