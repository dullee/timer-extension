import { useEffect, useState } from 'react'
import DevLayoutWindow from './components/DevLayoutWindow.jsx'
import Overlay from './components/Overlay.jsx'
import SettingsWindow from './components/SettingsWindow.jsx'
import { useExpiryChime, useSettings, useTimerState } from './hooks/useTimer.js'

/**
 * All three windows load the same bundle and pick their view from the URL
 * hash (`#/overlay`, `#/settings`, `#/dev-layout`), which is why main.js
 * appends one when loading. One bundle means one build and shared state
 * plumbing.
 */
function useRoute() {
  const read = () => window.location.hash.replace(/^#/, '') || '/overlay'
  const [route, setRoute] = useState(read)

  useEffect(() => {
    const onChange = () => setRoute(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}

export default function App() {
  const route = useRoute()
  const snapshot = useTimerState()
  const [settings] = useSettings()
  const isSettings = route.startsWith('/settings')

  // Only the overlay sounds the alert; Settings gets the same audio element
  // purely for its Test button. See the hook for why this matters.
  const previewChime = useExpiryChime(settings, { listenForExpiry: !isSettings })

  if (isSettings) {
    return <SettingsWindow snapshot={snapshot} settings={settings} previewChime={previewChime} />
  }

  if (route.startsWith('/dev-layout')) {
    return <DevLayoutWindow />
  }

  return <Overlay snapshot={snapshot} settings={settings} />
}
