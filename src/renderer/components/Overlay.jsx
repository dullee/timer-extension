import { useEffect, useState } from 'react'
import { formatClock } from '../lib/format.js'
import { RING_SIZE, RING_STROKE } from '../lib/theme.js'
import { useDevLayoutSync } from '../hooks/useDevLayout.js'
import ProgressRing from './ProgressRing.jsx'
import {
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  GearIcon,
  PauseIcon,
  PlayIcon,
  ResetIcon,
  SlidersIcon,
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

  // Dev builds only, in effect: applies whatever's in the Dev Layout window's
  // localStorage (nothing, normally) as CSS custom properties on this
  // window's root, and keeps re-applying live if that window changes one.
  // Every var(--dev-*, <default>) below falls back to the exact stock value
  // when nothing's been set, so this is a no-op for anyone who never opens
  // that window -- which in a packaged build is everyone, since it doesn't
  // exist there.
  useDevLayoutSync()

  if (!snapshot) return null

  const { state, remainingMs, durationMs, elapsedMs, label, mode: timerMode } = snapshot
  const mode = settings?.overlayMode ?? MODE.FLOATING
  // `isMini` gates the *richer* layout below (label, full-width transport
  // buttons, bigger clock/ring) -- and floating is now the bigger of the two
  // modes, not mini (see the OVERLAY_SIZES comment in store.js), so this
  // checks FLOATING despite the variable's name still reading like it should
  // check MINI. Every `isMini ? richContent : simpleContent` below stays
  // correct as long as this one line points at whichever mode is actually
  // the bigger one.
  const isMini = mode === MODE.FLOATING
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
  // Toggles to whichever mode isn't current -- has to be re-derived from
  // isMini's new meaning above, or this would set mode back to what it
  // already is instead of switching.
  const switchMode = () => api.setOverlayMode(isMini ? MODE.MINI : MODE.FLOATING)
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
      className={`drag flex h-full w-full flex-col justify-center rounded-2xl border border-ink/10 bg-surface/85 shadow-2xl backdrop-blur-xl ${
        // Mini's compact state is the tightest window on screen (100x64) and
        // has the least content to protect (just the clock, no icons) -- the
        // full 0.75rem padding other states need to keep the icon row off
        // the rounded corners is wasted space here, so it gets its own,
        // smaller fallback. Both still read the same --dev-card-padding-x
        // var, so the Dev Layout slider still overrides either uniformly.
        !isMini && !hovered
          ? 'px-[var(--dev-card-padding-x,0.5rem)]'
          : 'px-[var(--dev-card-padding-x,0.75rem)]'
      } ${expired ? 'ring-2 ring-accent/60' : ''}`}
    >
      {/* ---------- top row: always present ---------- */}
      {/*
        justify-center matters here: the window is a fixed width sized for
        the worst-case clock text ("1:05:04"), so any shorter time (which is
        most of the time) leaves leftover space in this row. Left-aligned
        (the flex default), that space all piles up on the right and reads
        as lopsided padding even though px-3 above is genuinely symmetric.
        Centering splits it evenly instead.
      */}
      <div className="flex items-center justify-center gap-[var(--dev-top-gap,0.5rem)] overflow-hidden">
        {/* Off by default -- omitted entirely rather than just hidden, so the
            clock claims the freed-up space instead of leaving a gap where the
            ring used to be. The "finished" cue doesn't disappear with it: the
            card's own ring-accent border (below) still pulses either way. */}
        {settings?.showProgressRing ? (
          <ProgressRing
            progress={expired ? 1 : progress}
            size={isMini ? RING_SIZE.mini : RING_SIZE.floating}
            stroke={RING_STROKE}
            className={expired ? 'animate-expired' : ''}
          />
        ) : null}

        {/*
          The clock is shrink-0 on purpose. As a flex-1 child it collapsed to a
          fraction of its content width and, having no clipping of its own, the
          overflowing digits painted straight over the buttons to its right.
          The window is a fixed size, so the countdown claims what it needs and
          the spacer below absorbs whatever is left.
        */}
        <div className={`shrink-0 ${isMini ? 'min-w-0' : ''}`}>
          <div
            className={`font-mono tabular-nums whitespace-nowrap leading-none ${accent} ${
              isMini ? 'text-2xl' : 'text-base'
            }`}
          >
            {formatClock(remainingMs)}
          </div>
          {isMini ? (
            <div className="mt-[var(--dev-label-margin-top,0.25rem)] truncate text-xs text-ink-muted">
              {expired ? 'Finished' : label || (isStopwatch ? 'Stopwatch' : 'No label')}
            </div>
          ) : null}
        </div>

        {/* Floating keeps its icon row inline -- the clock area is flex-1, so
            it just flexes around it. Mini drops its controls into a row
            below instead (see below), so it never needs this here. */}
        {isMini && hovered ? (

          <div className="flex shrink-0 items-center gap-[var(--dev-icon-gap,0.125rem)]">
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
            {settings?.isDev ? (
              <IconButton title="Dev layout" onClick={() => api.dev.openLayoutWindow()} className="size-6">
                <SlidersIcon className="size-3.5" />
              </IconButton>
            ) : null}
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

      {/* ---------- mini mode: controls row, dropping in from below ---------- */}
      {!isMini && hovered ? (
        <div className="mt-[var(--dev-controls-margin-top,0.625rem)] flex items-center justify-[var(--dev-controls-justify,center)] gap-[var(--dev-icon-gap,0.125rem)]">
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
          {settings?.isDev ? (
            <IconButton title="Dev layout" onClick={() => api.dev.openLayoutWindow()} className="size-6">
              <SlidersIcon className="size-3.5" />
            </IconButton>
          ) : null}
          <IconButton
            title="Hide overlay (stays in the tray)"
            onClick={() => api.hideOverlay()}
            className="size-6 hover:bg-danger/20 hover:text-danger"
          >
            <CloseIcon className="size-3.5" />
          </IconButton>
        </div>
      ) : null}

      {/* ---------- floating mode: full transport controls ---------- */}
      {isMini && hovered ? (
        <div className="mt-[var(--dev-controls-margin-top,0.625rem)] flex items-center gap-[var(--dev-transport-gap,0.5rem)]">
          {/* flex-1 so the primary button fills whatever the (fixed-width)
              Reset button doesn't -- without it the pair sits at their
              natural small width, left-aligned, leaving a large empty gap
              on the right that reads as lopsided padding. */}
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
