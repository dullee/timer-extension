import { useEffect, useState } from 'react'
import { formatClock } from '../lib/format.js'
import ProgressRing from './ProgressRing.jsx'
import {
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  GearIcon,
  PauseIcon,
  PlayIcon,
  ResetIcon,
  StopwatchIcon,
  TimerIcon
} from './Icons.jsx'

const api = window.timerAPI

const MODE = { FLOATING: 'floating', MINI: 'mini' }

function IconButton({ title, onClick, children, className = '', disabled = false }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      // .no-drag is mandatory inside a drag region -- without it the window
      // swallows the click and the button simply never fires.
      // shrink-0 matters just as much: the overlay is only ~200px wide, and
      // flex children shrink below their fixed size by default, which silently
      // collapsed these buttons to zero width.
      className={`no-drag grid shrink-0 place-items-center rounded-md text-ink-muted transition hover:enabled:bg-ink/10 hover:enabled:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright disabled:cursor-not-allowed disabled:opacity-30 ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * The always-on-top widget. Both sizes share this component; `mode` only
 * changes the layout, since the window itself is resized from the main process.
 */
export default function Overlay({ snapshot, settings }) {
  const [hovered, setHovered] = useState(false)

  // The drag region covers almost the whole window, and on Windows that area
  // never dispatches mouse events to the renderer (see main.js pollOverlayHover),
  // so hover is tracked from the main process instead of onMouseEnter/Leave.
  useEffect(() => api.onOverlayHoverChanged(setHovered), [])

  if (!snapshot) return null

  const { state, remainingMs, durationMs, elapsedMs, label, mode: timerMode } = snapshot
  const mode = settings?.overlayMode ?? MODE.FLOATING
  const isMini = mode === MODE.MINI
  const running = state === 'running'
  const expired = state === 'expired'
  const isStopwatch = timerMode === 'stopwatch'
  // A stopwatch has no target to show progress toward, so instead of a fixed
  // fill this sweeps once a minute like an analog stopwatch's second hand --
  // motion that reads as "counting up" even before you can make out the digits.
  const progress = isStopwatch
    ? (elapsedMs % 60000) / 60000
    : durationMs > 0
      ? elapsedMs / durationMs
      : 0

  const toggle = () => api.toggle()
  const reset = () => api.reset()
  const switchMode = () => api.setOverlayMode(isMini ? MODE.FLOATING : MODE.MINI)
  // Switching mode resets whatever's in progress (there's no sensible way to
  // carry a countdown's remaining time into a count-up), so it's only offered
  // once there's nothing to lose -- reset first to switch.
  const canSwitchTimerMode = state === 'idle' || state === 'expired'
  const toggleTimerMode = () => {
    if (canSwitchTimerMode) api.setMode(isStopwatch ? 'timer' : 'stopwatch')
  }

  // A monochrome palette has no spare hue for "finished" the way the old
  // green accent did; the pulsing ring plus the full accent-colored ring
  // below carry that signal instead, so the clock text itself just stays at
  // full strength (same as running) rather than switching color.
  const accent = state === 'paused' ? 'text-ink-muted' : 'text-ink'

  return (
    <div
      className={`drag flex h-full w-full flex-col justify-center rounded-2xl border border-ink/10 bg-surface/85 px-3 shadow-2xl backdrop-blur-xl ${
        expired ? 'ring-2 ring-accent/60' : ''
      }`}
    >
      {/* ---------- top row: always present ---------- */}
      <div className="flex items-center gap-2 overflow-hidden">
        <ProgressRing
          progress={expired ? 1 : progress}
          size={isMini ? 40 : 32}
          stroke={3}
          className={expired ? 'animate-expired' : ''}
        />

        {/*
          The clock is shrink-0 on purpose. As a flex-1 child it collapsed to a
          fraction of its content width and, having no clipping of its own, the
          overflowing digits painted straight over the buttons to its right.
          The window is a fixed size, so the countdown claims what it needs and
          the spacer below absorbs whatever is left.
        */}
        <div className={`shrink-0 ${isMini ? 'min-w-0 flex-1' : ''}`}>
          <div
            className={`font-mono tabular-nums whitespace-nowrap leading-none ${accent} ${
              isMini ? 'text-2xl' : 'text-base'
            }`}
          >
            {formatClock(remainingMs)}
          </div>
          {isMini ? (
            <div className="mt-1 truncate text-xs text-ink-muted">
              {expired ? 'Finished' : label || (isStopwatch ? 'Stopwatch' : 'No label')}
            </div>
          ) : null}
        </div>

        {/* Mini keeps its icon row inline -- the clock area is flex-1, so it
            just flexes around it. Floating drops its controls into a row
            below instead (see below), so it never needs this here. */}
        {isMini && hovered ? (

          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              title={
                !canSwitchTimerMode
                  ? 'Reset first to switch mode'
                  : isStopwatch
                    ? 'Switch to timer'
                    : 'Switch to stopwatch'
              }
              onClick={toggleTimerMode}
              disabled={!canSwitchTimerMode}
              className={`size-6 ${isStopwatch ? 'text-accent-bright' : ''}`}
            >
              {isStopwatch ? <StopwatchIcon className="size-3.5" /> : <TimerIcon className="size-3.5" />}
            </IconButton>
            <IconButton title="Compact size" onClick={switchMode} className="size-6">
              <CollapseIcon className="size-3" />
            </IconButton>
            <IconButton title="Settings" onClick={() => api.openSettings()} className="size-6">
              <GearIcon className="size-3.5" />
            </IconButton>
            <IconButton
              title="Hide overlay (stays in the tray)"
              onClick={() => api.hideOverlay()}
              className="size-6 hover:bg-danger/20 hover:text-danger"
            >
              <CloseIcon className="size-3.5" />
            </IconButton>
          </div>
        ) : null}
      </div>

      {/* ---------- floating mode: controls row, dropping in from below ---------- */}
      {!isMini && hovered ? (
        <div className="mt-2.5 flex items-center justify-center gap-0.5">
          <IconButton
            title={running ? 'Pause' : isStopwatch ? 'Start stopwatch' : 'Start'}
            onClick={toggle}
            className="size-6"
          >
            {running ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
          </IconButton>
          <IconButton
            title={
              !canSwitchTimerMode
                ? 'Reset first to switch mode'
                : isStopwatch
                  ? 'Switch to timer'
                  : 'Switch to stopwatch'
            }
            onClick={toggleTimerMode}
            disabled={!canSwitchTimerMode}
            className={`size-6 ${isStopwatch ? 'text-accent-bright' : ''}`}
          >
            {isStopwatch ? <StopwatchIcon className="size-3.5" /> : <TimerIcon className="size-3.5" />}
          </IconButton>
          <IconButton title="Expand" onClick={switchMode} className="size-6">
            <ExpandIcon className="size-3" />
          </IconButton>
          <IconButton title="Settings" onClick={() => api.openSettings()} className="size-6">
            <GearIcon className="size-3.5" />
          </IconButton>
          <IconButton
            title="Hide overlay (stays in the tray)"
            onClick={() => api.hideOverlay()}
            className="size-6 hover:bg-danger/20 hover:text-danger"
          >
            <CloseIcon className="size-3.5" />
          </IconButton>
        </div>
      ) : null}

      {/* ---------- mini mode: full transport controls ---------- */}
      {isMini && hovered ? (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={toggle}
            className="no-drag flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition hover:bg-accent-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright"
          >
            {running ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
            {running
              ? 'Pause'
              : state === 'paused'
                ? 'Resume'
                : isStopwatch
                  ? 'Start stopwatch'
                  : 'Start'}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={state === 'idle'}
            className="no-drag flex items-center justify-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-ink-muted transition hover:bg-ink/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright"
          >
            <ResetIcon className="size-3" />
            Reset
          </button>
        </div>
      ) : null}
    </div>
  )
}
