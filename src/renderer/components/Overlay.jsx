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
  ResetIcon
} from './Icons.jsx'

const api = window.timerAPI

const MODE = { FLOATING: 'floating', MINI: 'mini' }

function IconButton({ title, onClick, children, className = '' }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      // .no-drag is mandatory inside a drag region -- without it the window
      // swallows the click and the button simply never fires.
      // shrink-0 matters just as much: the overlay is only ~200px wide, and
      // flex children shrink below their fixed size by default, which silently
      // collapsed these buttons to zero width.
      className={`no-drag grid shrink-0 place-items-center rounded-md text-ink-muted transition hover:bg-white/10 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright ${className}`}
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

  const { state, remainingMs, durationMs, elapsedMs, label } = snapshot
  const mode = settings?.overlayMode ?? MODE.FLOATING
  const isMini = mode === MODE.MINI
  const running = state === 'running'
  const expired = state === 'expired'
  const progress = durationMs > 0 ? elapsedMs / durationMs : 0

  const toggle = () => api.toggle()
  const reset = () => api.reset()
  const switchMode = () => api.setOverlayMode(isMini ? MODE.FLOATING : MODE.MINI)

  const accent = expired
    ? 'text-success'
    : state === 'paused'
      ? 'text-ink-muted'
      : 'text-ink'

  return (
    <div
      className={`drag flex h-full w-full flex-col justify-center rounded-2xl border border-white/10 bg-surface/85 px-3 shadow-2xl backdrop-blur-xl ${
        expired ? 'ring-2 ring-success/60' : ''
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
              {expired ? 'Finished' : label || 'No label'}
            </div>
          ) : null}
        </div>

        {/* Mini keeps its icon row inline -- the clock area is flex-1, so it
            just flexes around it. Floating drops its controls into a row
            below instead (see below), so it never needs this here. */}
        {isMini && hovered ? (
          <div>
          <div className="flex shrink-0 items-center gap-0.5">
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
          </div> </div>
        ) : null}
      </div>

      {/* ---------- floating mode: controls row, dropping in from below ---------- */}
      {!isMini && hovered ? (
        <div className="mt-2.5 flex items-center justify-center gap-0.5">
          <IconButton title={running ? 'Pause' : 'Start'} onClick={toggle} className="size-6">
            {running ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
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
            className="no-drag flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright"
          >
            {running ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
            {running ? 'Pause' : state === 'paused' ? 'Resume' : 'Start'}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={state === 'idle'}
            className="no-drag flex items-center justify-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-ink-muted transition hover:bg-white/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright"
          >
            <ResetIcon className="size-3" />
            Reset
          </button>
        </div>
      ) : null}
    </div>
  )
}
