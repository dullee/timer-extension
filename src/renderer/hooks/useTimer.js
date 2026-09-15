import { useEffect, useRef, useState } from 'react'
import chimeUrl from '../../assets/chime.wav'

const api = window.timerAPI

/** Live timer snapshot, seeded from the main process and kept current by IPC. */
export function useTimerState() {
  const [snapshot, setSnapshot] = useState(null)

  useEffect(() => {
    let active = true
    api.getState().then((state) => {
      if (active) setSnapshot(state)
    })
    const unsubscribe = api.onState(setSnapshot)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return snapshot
}

export function useSettings() {
  const [settings, setSettings] = useState(null)

  useEffect(() => {
    let active = true
    api.getSettings().then((next) => {
      if (active) setSettings(next)
    })
    const unsubscribe = api.onSettingsChanged(setSettings)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return [settings, setSettings]
}

/**
 * Plays the bundled chime when the timer expires, and returns a preview
 * function for the Test button.
 *
 * `listenForExpiry` matters: both windows load this same bundle, so if both
 * subscribed the chime would play twice whenever Settings happened to be open.
 * Only the overlay listens -- and main.js force-shows the overlay on expiry,
 * so there is always exactly one listener.
 *
 * The Audio element is created once and reused: constructing one per expiry
 * leaks decoded audio and lets the first play race the decode. `settings` is
 * read through a ref so changing the volume never re-subscribes the listener
 * (which would otherwise drop and re-add it mid-countdown).
 */
export function useExpiryChime(settings, { listenForExpiry = true } = {}) {
  const audioRef = useRef(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => {
    const audio = new Audio(chimeUrl)
    audio.preload = 'auto'
    audioRef.current = audio
    return () => {
      audio.pause()
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!listenForExpiry) return undefined
    const unsubscribe = api.onExpired(() => {
      const current = settingsRef.current
      if (current && current.soundEnabled === false) return
      const audio = audioRef.current
      if (!audio) return
      audio.volume = current?.volume ?? 0.7
      audio.currentTime = 0
      // Autoplay is permitted via the window's autoplayPolicy, but a rejected
      // promise here would otherwise surface as an unhandled rejection.
      audio.play().catch((err) => console.warn('chime blocked:', err.message))
    })
    return unsubscribe
  }, [listenForExpiry])

  /** Used by the Test Sound button in Settings. */
  return function preview(volume) {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume ?? settingsRef.current?.volume ?? 0.7
    audio.currentTime = 0
    audio.play().catch(() => {})
  }
}
