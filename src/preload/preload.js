const { contextBridge, ipcRenderer } = require('electron')

/**
 * The entire surface the renderer gets. Every channel is named explicitly --
 * no generic `invoke(channel, ...)` passthrough, which would hand a
 * compromised renderer the run of the main process.
 */
const api = {
  /* --------------------------------------------------------- timer state */
  getState: () => ipcRenderer.invoke('timer:get-state'),
  start: (payload) => ipcRenderer.invoke('timer:start', payload),
  pause: () => ipcRenderer.invoke('timer:pause'),
  resume: () => ipcRenderer.invoke('timer:resume'),
  toggle: () => ipcRenderer.invoke('timer:toggle'),
  reset: () => ipcRenderer.invoke('timer:reset'),
  setMode: (mode) => ipcRenderer.invoke('timer:set-mode', mode),
  setDuration: (durationMs) => ipcRenderer.invoke('timer:set-duration', durationMs),
  setLabel: (label) => ipcRenderer.invoke('timer:set-label', label),

  /**
   * Subscribes to timer snapshots. Returns an unsubscribe function so React
   * effects can clean up -- without it, every hot reload would stack another
   * listener and trip Electron's max-listeners warning.
   */
  onState: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('timer:state', handler)
    return () => ipcRenderer.removeListener('timer:state', handler)
  },

  onExpired: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('timer:expired', handler)
    return () => ipcRenderer.removeListener('timer:expired', handler)
  },

  /* ------------------------------------------------------------ settings */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  regenerateToken: () => ipcRenderer.invoke('settings:regenerate-token'),
  onSettingsChanged: (callback) => {
    const handler = (_event, settings) => callback(settings)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  },

  /* -------------------------------------------------------------- server */
  getServerInfo: () => ipcRenderer.invoke('server:info'),

  /* ------------------------------------------------------------- windows */
  setOverlayMode: (mode) => ipcRenderer.invoke('window:set-overlay-mode', mode),
  hideOverlay: () => ipcRenderer.invoke('window:hide-overlay'),
  openSettings: () => ipcRenderer.invoke('window:open-settings'),
  closeSettings: () => ipcRenderer.invoke('window:close-settings'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:set-always-on-top', value),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onOverlayHoverChanged: (callback) => {
    const handler = (_event, hovered) => callback(hovered)
    ipcRenderer.on('overlay:hover', handler)
    return () => ipcRenderer.removeListener('overlay:hover', handler)
  },

  /* -------------------------------------------------------------- google */
  google: {
    getStatus: () => ipcRenderer.invoke('google:status'),
    connect: () => ipcRenderer.invoke('google:connect'),
    disconnect: () => ipcRenderer.invoke('google:disconnect'),
    listTaskLists: () => ipcRenderer.invoke('google:list-task-lists'),
    listTasks: (taskListId) => ipcRenderer.invoke('google:list-tasks', taskListId),
    onStatusChanged: (callback) => {
      const handler = (_event, status) => callback(status)
      ipcRenderer.on('google:status-changed', handler)
      return () => ipcRenderer.removeListener('google:status-changed', handler)
    }
  }
}

contextBridge.exposeInMainWorld('timerAPI', api)
