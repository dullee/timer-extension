import { useEffect, useState } from 'react'
import { applyDevLayout, loadDevLayout, saveDevLayout, DEV_LAYOUT_STORAGE_KEY } from '../lib/devLayout.js'

/**
 * Applies the persisted dev-layout overrides to this window's CSS on mount,
 * and keeps them live if another window (the Dev Layout panel) changes one.
 * localStorage is shared across every window in the app, and the browser's
 * `storage` event fires in every window *except* the one that wrote it --
 * exactly the live-preview wiring this needs, with no IPC involved at all.
 *
 * Used by Overlay.jsx (the window actually being tuned); it doesn't need to
 * read the values itself, only to keep applying whatever's current.
 */
export function useDevLayoutSync() {
  useEffect(() => {
    applyDevLayout(loadDevLayout())
    const onStorage = (e) => {
      if (e.key === DEV_LAYOUT_STORAGE_KEY) applyDevLayout(loadDevLayout())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
}

/**
 * Used by the Dev Layout window itself: read/write the persisted values, and
 * apply them locally too -- `storage` only fires in *other* windows, so the
 * window making the edit has to preview its own change directly.
 */
export function useDevLayoutEditor() {
  const [values, setValues] = useState(() => loadDevLayout())

  useEffect(() => {
    applyDevLayout(values)
  }, [values])

  const setField = (key, value) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value }
      saveDevLayout(next)
      return next
    })
  }

  const resetField = (key) => {
    setValues((prev) => {
      const next = { ...prev }
      delete next[key]
      saveDevLayout(next)
      return next
    })
  }

  const resetAll = () => {
    setValues({})
    saveDevLayout({})
  }

  return { values, setField, resetField, resetAll }
}
