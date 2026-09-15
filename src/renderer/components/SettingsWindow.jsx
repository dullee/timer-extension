import { useCallback, useEffect, useState } from 'react'
import { PRESETS, formatDurationLabel, joinDuration, splitDuration } from '../lib/format.js'
import { CheckIcon, CopyIcon, GoogleIcon } from './Icons.jsx'

const api = window.timerAPI

/* ------------------------------------------------------------- primitives */

function Section({ title, description, children }) {
  return (
    <section className="rounded-xl border border-border-subtle bg-surface-raised/60 p-5">
      <h2 className="text-sm font-semibold tracking-wide text-ink uppercase">{title}</h2>
      {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-ink">{label}</div>
        {hint ? <div className="text-xs text-ink-muted">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright ${
        checked ? 'bg-accent' : 'bg-border-subtle'
      }`}
    >
      {/*
        on-accent, not a fixed white: the track flips from near-black (light
        mode) to near-white (dark mode), so a knob that stayed white would
        vanish against a white track in dark mode. shadow-sm keeps it legible
        against the unchecked track too, which is a light neutral gray in
        light mode where a plain white knob would barely stand out.
      */}
      <span
        className={`absolute top-0.5 size-5 rounded-full bg-on-accent shadow-sm transition-all ${
          checked ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function Button({ children, variant = 'secondary', className = '', ...rest }) {
  const variants = {
    primary: 'bg-accent text-on-accent hover:bg-accent-bright',
    secondary: 'border border-border-subtle text-ink hover:bg-ink/5',
    danger: 'border border-danger/40 text-danger hover:bg-danger/10'
  }
  return (
    <button
      type="button"
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

const inputClass =
  'rounded-lg border border-border-subtle bg-surface-input px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent'

function NumberField({ value, onChange, max, label }) {
  return (
    <label className="flex flex-col items-center gap-1">
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${inputClass} w-16 text-center font-mono tabular-nums`}
      />
      <span className="text-[11px] text-ink-muted uppercase">{label}</span>
    </label>
  )
}

function CopyField({ value, secret = false }) {
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(!secret)

  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={revealed ? value : '•'.repeat(Math.min(32, value.length))}
        onFocus={(e) => e.target.select()}
        className={`${inputClass} w-full flex-1 font-mono text-xs`}
      />
      {secret ? (
        <Button onClick={() => setRevealed((v) => !v)} className="shrink-0">
          {revealed ? 'Hide' : 'Show'}
        </Button>
      ) : null}
      <Button onClick={copy} className="flex shrink-0 items-center gap-1.5">
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function Banner({ tone = 'info', children }) {
  const tones = {
    info: 'border-accent/40 bg-accent/10 text-ink',
    warn: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    error: 'border-danger/40 bg-danger/10 text-danger'
  }
  return <div className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}>{children}</div>
}

/* ------------------------------------------------------------ main window */

export default function SettingsWindow({ snapshot, settings, previewChime }) {
  const [serverInfo, setServerInfo] = useState(null)
  const [googleStatus, setGoogleStatus] = useState(null)
  const [taskLists, setTaskLists] = useState([])
  const [tasks, setTasks] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [tokenNotice, setTokenNotice] = useState(false)

  const duration = splitDuration(settings?.lastDurationMs ?? 0)

  const patch = useCallback((next) => api.updateSettings(next), [])

  useEffect(() => {
    api.getServerInfo().then(setServerInfo)
    api.google.getStatus().then(setGoogleStatus)
    return api.google.onStatusChanged(setGoogleStatus)
  }, [])

  // Task lists are only meaningful once we're signed in.
  useEffect(() => {
    if (!googleStatus?.connected) {
      setTaskLists([])
      return
    }
    api.google
      .listTaskLists()
      .then(setTaskLists)
      .catch((err) => setError(err.message))
  }, [googleStatus?.connected])

  useEffect(() => {
    if (!googleStatus?.connected || !settings?.taskListId) {
      setTasks([])
      return
    }
    api.google
      .listTasks(settings.taskListId)
      .then(setTasks)
      .catch((err) => setError(err.message))
  }, [googleStatus?.connected, settings?.taskListId])

  if (!settings) return null

  const run = async (key, fn) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const setDurationPart = (part, value) => {
    const next = joinDuration({ ...duration, [part]: value })
    if (next > 0) patch({ lastDurationMs: next })
  }

  const baseUrl = serverInfo?.baseUrl ?? 'http://127.0.0.1:3000'
  const isStopwatch = settings.lastMode === 'stopwatch'
  // Switching mode resets whatever's running (a countdown's remaining time
  // has no sensible count-up equivalent), so -- same as the overlay's own
  // toggle -- it's only offered once there's nothing to lose.
  const canSwitchMode = !snapshot || snapshot.state === 'idle' || snapshot.state === 'expired'

  return (
    <div className="settings-root h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-3xl space-y-5 px-6 py-8">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold text-ink">Timer settings</h1>
            <p className="text-sm text-ink-muted">
              Version {settings.appVersion}
              {serverInfo?.port ? ` · API on port ${serverInfo.port}` : ' · API offline'}
            </p>
          </div>
          <Button onClick={() => api.closeSettings()}>Close</Button>
        </header>

        {error ? <Banner tone="error">{error}</Banner> : null}

        {/* ---------------------------------------------------------- timer */}
        <Section
          title="Timer"
          description={
            isStopwatch
              ? 'Stopwatches count up from zero -- there is no duration to set.'
              : 'The duration used when a timer starts without one.'
          }
        >
          <Row label="Mode">
            <div className="flex gap-2">
              {[
                { id: 'timer', label: 'Timer' },
                { id: 'stopwatch', label: 'Stopwatch' }
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={!canSwitchMode}
                  onClick={() => patch({ lastMode: option.id })}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    settings.lastMode === option.id
                      ? 'border-accent bg-accent/20 text-ink'
                      : 'border-border-subtle text-ink-muted hover:enabled:bg-ink/5 hover:enabled:text-ink'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Row>
          {!canSwitchMode ? (
            <p className="-mt-2 text-xs text-ink-muted">Reset the timer to switch modes.</p>
          ) : null}

          {!isStopwatch ? (
            <>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.ms}
                    type="button"
                    onClick={() => patch({ lastDurationMs: preset.ms })}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                      settings.lastDurationMs === preset.ms
                        ? 'border-accent bg-accent/20 text-ink'
                        : 'border-border-subtle text-ink-muted hover:bg-ink/5 hover:text-ink'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <Row label="Custom duration" hint={formatDurationLabel(settings.lastDurationMs)}>
                <div className="flex items-start gap-2">
                  <NumberField
                    value={duration.hours}
                    onChange={(v) => setDurationPart('hours', v)}
                    max={23}
                    label="hrs"
                  />
                  <NumberField
                    value={duration.minutes}
                    onChange={(v) => setDurationPart('minutes', v)}
                    max={59}
                    label="min"
                  />
                  <NumberField
                    value={duration.seconds}
                    onChange={(v) => setDurationPart('seconds', v)}
                    max={59}
                    label="sec"
                  />
                </div>
              </Row>
            </>
          ) : null}

          <Row label="Default label" hint="Shown on the overlay and in notifications.">
            <input
              type="text"
              value={settings.lastLabel ?? ''}
              placeholder={isStopwatch ? 'Cooking' : 'Focus block'}
              onChange={(e) => patch({ lastLabel: e.target.value })}
              className={`${inputClass} w-56`}
            />
          </Row>

          <div className="flex gap-2 border-t border-border-subtle pt-4">
            <Button variant="primary" onClick={() => api.start({ durationMs: settings.lastDurationMs, label: settings.lastLabel })}>
              {isStopwatch ? 'Start stopwatch' : 'Start now'}
            </Button>
            <Button onClick={() => api.reset()} disabled={snapshot?.state === 'idle'}>
              Reset
            </Button>
          </div>
        </Section>

        {/* -------------------------------------------------------- overlay */}
        <Section title="Overlay" description="How the floating widget behaves on screen.">
          <Row label="Size">
            <div className="flex gap-2">
              {[
                { id: 'floating', label: 'Floating' },
                { id: 'mini', label: 'Mini' }
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => patch({ overlayMode: option.id })}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                    settings.overlayMode === option.id
                      ? 'border-accent bg-accent/20 text-ink'
                      : 'border-border-subtle text-ink-muted hover:bg-ink/5 hover:text-ink'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Row>

          <Row label="Always on top" hint="Floats above other windows, including fullscreen apps.">
            <Toggle
              label="Always on top"
              checked={settings.alwaysOnTop}
              onChange={(v) => api.setAlwaysOnTop(v)}
            />
          </Row>

          <Row label="Show overlay at launch">
            <Toggle
              label="Show overlay at launch"
              checked={settings.showOverlayOnStart}
              onChange={(v) => patch({ showOverlayOnStart: v })}
            />
          </Row>

          <Row label="Show progress ring" hint="The circular indicator around the clock. Off by default.">
            <Toggle
              label="Show progress ring"
              checked={settings.showProgressRing}
              onChange={(v) => patch({ showProgressRing: v })}
            />
          </Row>
        </Section>

        {/* ------------------------------------------------ sound & notify */}
        <Section title="Alerts" description="What happens the moment a timer reaches zero.">
          <Row label="Play chime">
            <Toggle
              label="Play chime"
              checked={settings.soundEnabled}
              onChange={(v) => patch({ soundEnabled: v })}
            />
          </Row>

          <Row label="Volume" hint={`${Math.round(settings.volume * 100)}%`}>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.volume}
                onChange={(e) => patch({ volume: Number(e.target.value) })}
                className="w-40 accent-[var(--color-accent)]"
              />
              <Button onClick={() => previewChime(settings.volume)}>Test</Button>
            </div>
          </Row>

          <Row label="Desktop notification">
            <Toggle
              label="Desktop notification"
              checked={settings.notificationsEnabled}
              onChange={(v) => patch({ notificationsEnabled: v })}
            />
          </Row>
        </Section>

        {/* ------------------------------------------------------ local API */}
        <Section
          title="Local API"
          description="Control the timer from scripts and other apps. Bound to 127.0.0.1 only."
        >
          {serverInfo?.port ? (
            <>
              {settings.preferredPort !== serverInfo.port ? (
                <Banner tone="warn">
                  Port {settings.preferredPort} was busy, so the API is on {serverInfo.port}.
                </Banner>
              ) : null}

              <Row label="Base URL">
                <code className="rounded bg-surface-input px-2 py-1 font-mono text-xs text-accent-bright">
                  {baseUrl}
                </code>
              </Row>

              <Row label="Preferred port" hint="Takes effect on the next launch.">
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={settings.preferredPort}
                  onChange={(e) => patch({ preferredPort: Number(e.target.value) })}
                  className={`${inputClass} w-24 text-center font-mono`}
                />
              </Row>

              <div>
                <div className="mb-2 text-sm text-ink">API token</div>
                <CopyField value={settings.apiToken} secret />
                {tokenNotice ? (
                  <Banner tone="warn">
                    <span className="mt-2 block">
                      New token saved. Restart Timer for the server to start accepting it.
                    </span>
                  </Banner>
                ) : null}
                <div className="mt-2">
                  <Button
                    variant="danger"
                    onClick={() =>
                      run('token', async () => {
                        await api.regenerateToken()
                        setTokenNotice(true)
                      })
                    }
                    disabled={busy === 'token'}
                  >
                    Regenerate token
                  </Button>
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm text-ink">Quick test</div>
                <pre className="overflow-x-auto rounded-lg bg-surface-input p-3 font-mono text-xs leading-relaxed text-ink-muted">
{`curl -X POST ${baseUrl}/api/timer/start \\
  -H "X-API-Key: <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"durationMs": 60000, "label": "Focus"}'`}
                </pre>
                {serverInfo.discoveryPath ? (
                  <p className="mt-2 text-xs text-ink-muted">
                    Scripts can read the live port and token from{' '}
                    <code className="font-mono">{serverInfo.discoveryPath}</code>.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <Banner tone="error">
              The local API failed to start. The timer still works, but REST control is unavailable.
            </Banner>
          )}
        </Section>

        {/* --------------------------------------------------------- google */}
        <Section
          title="Google Tasks"
          description="Optionally tick off a to-do when the timer finishes."
        >
          {!googleStatus?.configured ? (
            <Banner tone="warn">
              Google OAuth isn't configured yet. Add <code className="font-mono">MAIN_VITE_GOOGLE_CLIENT_ID</code>{' '}
              and <code className="font-mono">MAIN_VITE_GOOGLE_CLIENT_SECRET</code> to a{' '}
              <code className="font-mono">.env</code> file — see the README for the Cloud Console steps.
            </Banner>
          ) : googleStatus?.connected ? (
            <>
              <Row
                label={googleStatus.email ?? 'Connected'}
                hint={
                  settings.tokenStorageEncrypted
                    ? 'Tokens encrypted with the OS keychain.'
                    : 'OS keychain unavailable — tokens stored unencrypted.'
                }
              >
                <Button
                  variant="danger"
                  onClick={() => run('signout', () => api.google.disconnect())}
                  disabled={busy === 'signout'}
                >
                  Disconnect
                </Button>
              </Row>

              {!settings.tokenStorageEncrypted ? (
                <Banner tone="warn">
                  No OS keychain is available on this machine, so Google tokens are saved in plain
                  text under your user data directory.
                </Banner>
              ) : null}

              <Row label="Task list">
                <select
                  value={settings.taskListId ?? ''}
                  onChange={(e) => patch({ taskListId: e.target.value || null, taskId: null })}
                  className={`${inputClass} w-56`}
                >
                  <option value="">Select a list…</option>
                  {taskLists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.title}
                    </option>
                  ))}
                </select>
              </Row>

              <Row label="Task to complete">
                <select
                  value={settings.taskId ?? ''}
                  onChange={(e) => patch({ taskId: e.target.value || null })}
                  disabled={!settings.taskListId}
                  className={`${inputClass} w-56 disabled:opacity-40`}
                >
                  <option value="">
                    {tasks.length === 0 ? 'No open tasks' : 'Select a task…'}
                  </option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </Row>

              <Row
                label="Complete the task when the timer ends"
                hint="The task is cleared from this setting once completed."
              >
                <Toggle
                  label="Auto-complete task"
                  checked={settings.autoCompleteTaskEnabled}
                  onChange={(v) => patch({ autoCompleteTaskEnabled: v })}
                />
              </Row>
            </>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-ink-muted">
                Sign-in opens in your normal browser — Google blocks OAuth inside embedded app
                windows.
              </p>
              <Button
                variant="primary"
                onClick={() => run('connect', () => api.google.connect())}
                disabled={busy === 'connect'}
                className="flex items-center gap-2"
              >
                <GoogleIcon className="size-4" />
                {busy === 'connect' ? 'Opening browser…' : 'Connect Google account'}
              </Button>
            </div>
          )}
        </Section>

        <footer className="pb-4 text-center text-xs text-ink-muted">
          Settings are stored in{' '}
          <code className="font-mono">{settings.userDataPath}</code>
        </footer>
      </div>
    </div>
  )
}
