import { useEffect, useRef, useState } from 'react'
import { formatClock, joinDuration, splitDuration } from '../lib/format.js'
import { RING_SIZE, RING_STROKE } from '../lib/theme.js'
import { useDevLayoutSync } from '../hooks/useDevLayout.js'
import ProgressRing from './ProgressRing.jsx'
import {
  CloseIcon,
  GearIcon,
  PauseIcon,
  PlayIcon,
  ResetIcon,
  StopwatchIcon,
  TimerIcon
} from './Icons.jsx'

const api = window.timerAPI

const MODE = { FLOATING: 'floating', MINI: 'mini' }

// The order the segmented duration editor's fields sit in, left (biggest)
// to right (smallest) -- see durationEdit's shape below.
const DURATION_SEGMENTS = ['h', 'm', 's']

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
  // Click-to-edit the countdown length, as a real segmented H/M/S picker
  // rather than free text: `null` means "not editing"; while editing, this
  // is { h, m, s, active, raw } -- h/m/s are always the current, already
  // zero-padded 2-digit value for each field (the source of truth for the
  // live ms preview), `active` is which of the three (0/1/2) currently has
  // the caret, and `raw` is the keystrokes typed into *that* field since it
  // last gained focus (never more than 2 chars) -- kept separately from the
  // padded h/m/s value so the first digit typed into a freshly-focused
  // field overwrites it instead of appending onto whatever was already
  // there. See handleDurationKeyDown below for how typing, backspacing,
  // and arrowing between fields all drive this.
  const [durationEdit, setDurationEdit] = useState(null)
  // The edit field is a plain focusable div, not an <input> -- see its JSX
  // below for why -- so there's no declarative autoFocus; this ref plus the
  // effect right under it is what actually moves focus into it the instant
  // editing starts.
  const durationEditRef = useRef(null)
  useEffect(() => {
    if (durationEdit !== null) durationEditRef.current?.focus()
    // Only the null <-> non-null transition should refocus -- not every
    // keystroke, which is why this depends on that boolean rather than
    // durationEdit itself.
  }, [durationEdit !== null])

  // Tells the main process to widen the overlay window while editing --
  // the three-field picker needs real room mini's usual widths were never
  // sized for (see OVERLAY_WIDE_WIDTHS in store.js) -- and to drop back
  // down once editing ends. One effect covers every path that opens or
  // closes an edit (the click-to-edit itself, Enter/Escape/blur commits,
  // and the auto-cancel effects below) instead of a setOverlayEditingDuration
  // call at each of those call sites individually.
  useEffect(() => {
    api.setOverlayEditingDuration(durationEdit !== null)
  }, [durationEdit !== null])

  // The drag region covers almost the whole window, and on Windows that area
  // never dispatches mouse events to the renderer (see main.js pollOverlayHover),
  // so hover is tracked from the main process instead of onMouseEnter/Leave.
  useEffect(() => api.onOverlayHoverChanged(setHovered), [])

  // Bails out of an open duration edit if something *external* (the tray
  // menu, the API, another window) starts the timer, switches to stopwatch,
  // etc. out from under it -- without this, the field would sit there
  // showing a stale edit for a duration that's no longer editable. Doesn't
  // fire just because the edit itself changed, only when its own
  // preconditions do -- see canEditDuration below, recomputed here directly
  // off the snapshot since hooks can't come after the early `return null`.
  useEffect(() => {
    const canEdit = snapshot && snapshot.mode !== 'stopwatch' && (snapshot.state === 'idle' || snapshot.state === 'expired')
    if (!canEdit) setDurationEdit(null)
  }, [snapshot?.mode, snapshot?.state])

  // Also ends an open edit the moment the pointer leaves the overlay --
  // same commit-then-close as blur (see commitDurationEdit below), just
  // triggered by hover instead of focus, since the two can drift apart:
  // focus stays on the field even once the mouse has left the window
  // (hover is only ever tracked via main.js's poll, never a real DOM
  // blur), so without this an edit left mid-type would just sit there
  // showing a stale value after you'd already moved on. The functional
  // updater reads the latest edit without needing it in the dependency
  // array, so this only actually runs on the hovered->unhovered edge, not
  // on every keystroke.
  useEffect(() => {
    if (hovered) return
    setDurationEdit((d) => {
      if (d === null) return d
      const ms = joinDuration({ hours: Number(d.h), minutes: Number(d.m), seconds: Number(d.s) })
      if (ms > 0) api.setDuration(ms)
      return null
    })
  }, [hovered])

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
  // Switching mode resets whatever's in progress (there's no sensible way to
  // carry a countdown's remaining time into a count-up), so it's only offered
  // once there's nothing to lose -- reset first to switch.
  const canSwitchTimerMode = state === 'idle' || state === 'expired'
  const toggleTimerMode = () => {
    if (canSwitchTimerMode) api.setMode(isStopwatch ? 'timer' : 'stopwatch')
  }

  // The clock only turns into a typeable field for the countdown, not the
  // stopwatch (there's nothing to type -- it counts up from zero), and only
  // idle/expired -- the same guard as switching modes, and for the same
  // reason: setDuration() silently banks the new value without applying it
  // while running/paused (see timer-engine.js), which would make typing a
  // new time while the countdown is live look like it did nothing.
  const canEditDuration = !isStopwatch && canSwitchTimerMode
  const pad2 = (n) => String(n).padStart(2, '0')
  const startEditingDuration = () => {
    if (!canEditDuration) return
    const { hours, minutes, seconds } = splitDuration(durationMs)
    // Starts on minutes, not hours -- most timers are set in whole minutes
    // with hours and seconds left at 0, so that's the field someone
    // clicking in is almost always about to type into.
    setDurationEdit({ h: pad2(hours), m: pad2(minutes), s: pad2(seconds), active: 1, raw: '' })
  }
  const commitDurationEdit = () => {
    if (durationEdit === null) return
    const ms = joinDuration({ hours: Number(durationEdit.h), minutes: Number(durationEdit.m), seconds: Number(durationEdit.s) })
    if (ms > 0) api.setDuration(ms)
    setDurationEdit(null)
  }
  // A real three-field picker, not free text: each keystroke acts on
  // whichever field is `active`, addressed by DURATION_SEGMENTS[active].
  //
  // Typing a digit appends it to that field's `raw` (max 2 chars) and
  // shows it zero-padded; once raw reaches 2 digits the field is "full" and
  // focus auto-advances to the next one (seconds just stays put and starts
  // overwriting fresh, having nowhere further to advance to) -- exactly
  // like a native H:M:S input, and unlike the previous cents-style buffer
  // this replaced, where every keystroke landed in the same trailing slot
  // and the caret never had anywhere else to be.
  //
  // Backspace clears one digit of `raw` if there's anything typed in the
  // active field; once that field is empty, the *next* backspace jumps to
  // the previous field (hours before minutes before seconds) and clears
  // it, rather than doing nothing or wrapping around to seconds -- the
  // same "biggest units first" order the old buffer's delete had, just
  // expressed as focus moving backward through fields instead of a single
  // buffer shifting.
  const handleDurationKeyDown = (e) => {
    if (e.key === 'Tab' || durationEdit === null) return
    e.preventDefault()
    const { active, raw } = durationEdit
    const key = DURATION_SEGMENTS[active]

    if (/^[0-9]$/.test(e.key)) {
      const nextRaw = (raw + e.key).slice(-2)
      const advance = nextRaw.length === 2 && active < DURATION_SEGMENTS.length - 1
      setDurationEdit({
        ...durationEdit,
        [key]: pad2(nextRaw),
        raw: advance ? '' : nextRaw,
        active: advance ? active + 1 : active
      })
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (raw.length > 0) {
        const nextRaw = raw.slice(0, -1)
        setDurationEdit({ ...durationEdit, [key]: pad2(nextRaw), raw: nextRaw })
      } else if (active > 0) {
        const prevKey = DURATION_SEGMENTS[active - 1]
        setDurationEdit({ ...durationEdit, [prevKey]: '00', active: active - 1, raw: '' })
      } else {
        setDurationEdit({ ...durationEdit, h: '00' })
      }
    } else if (e.key === 'ArrowLeft' && active > 0) {
      setDurationEdit({ ...durationEdit, active: active - 1, raw: '' })
    } else if (e.key === 'ArrowRight' && active < DURATION_SEGMENTS.length - 1) {
      setDurationEdit({ ...durationEdit, active: active + 1, raw: '' })
    } else if (e.key === 'Enter') {
      commitDurationEdit()
    } else if (e.key === 'Escape') {
      setDurationEdit(null)
    }
  }
  const focusDurationSegment = (index) => {
    if (durationEdit !== null) setDurationEdit({ ...durationEdit, active: index, raw: '' })
  }

  // A monochrome palette has no spare hue for "finished" the way the old
  // green accent did; the pulsing ring plus the full accent-colored ring
  // below carry that signal instead, so the clock text itself just stays at
  // full strength (same as running) rather than switching color.
  const accent = state === 'paused' ? 'text-ink-muted' : 'text-ink'

  return (
    <div
      // The clock sits at a fixed offset from the top -- 23px (floating) /
      // 10px (mini) -- applied unconditionally, in both hover and idle
      // states, rather than switching to justify-center while idle. It's
      // not just an anti-jump measure for hover *starting*: centering was
      // also live-recalculated on every frame of the shrink-back animation
      // when hover *ends*, since removing the button row instantly (while
      // the window was still mid-animation, at its larger hovered height)
      // made the clock jump straight to the middle of that still-tall box
      // before sliding back up as the window caught up. A fixed offset
      // can't do that: it was already measured to exactly match where
      // centering alone would place the clock in each mode's compact state
      // (so idle looks pixel-identical to before), and now it simply never
      // moves, independent of the window's current height or what is or
      // isn't mounted below it.
      // Mini's offset must stay in lockstep with OVERLAY_COMPACT_SIZES.MINI's
      // height in store.js -- it's (compact height - 16px clock line height)
      // / 2, so a future resize of the compact box needs a matching edit
      // here or this same jump comes back.
      className={`drag flex h-full w-full flex-col justify-start overflow-hidden rounded-2xl border border-ink/10 bg-surface/85 shadow-2xl backdrop-blur-xl ${
        isMini ? 'pt-[1.4375rem]' : 'pt-[0.625rem]'
      } ${
        // Mini's compact state is the tightest window on screen (84x54) and
        // has the least content to protect (just the clock, no icons) -- the
        // full 0.75rem padding other states need to keep the icon row off
        // the rounded corners is wasted space here, so it gets its own,
        // smaller fallback. Both still read the same --dev-card-padding-x
        // var, so the Dev Layout slider still overrides either uniformly.
        !isMini && !hovered
          ? 'px-[var(--dev-card-padding-x,0.375rem)]'
          : 'px-[var(--dev-card-padding-x,0.75rem)]'
      } ${expired ? 'ring-2 ring-accent/60' : ''}`}
    >
      {/* ---------- top row: always present ---------- */}
      {/*
        Centering the clock (justify-center) only holds up while it's the
        row's *only* child: the window is a fixed width sized for the
        worst-case clock text ("1:05:04"), so any shorter time (most of the
        time) leaves leftover space that, left-aligned, all piles up on one
        side and reads as lopsided padding even though px-3 is genuinely
        symmetric -- centering splits that evenly.
        But floating's icon row joins this same line on hover (see below),
        and centering a *group* means the clock's own position depends on
        whatever else is in the row -- the instant the icons mount, before
        the window has grown to fit them, the whole cluster (now wider)
        re-centers and the clock visibly jumps, with the icons pushed past
        the still-narrow right edge. Switching to justify-between once the
        icons are present anchors the clock to the left and the icons to
        the right independently, so neither's position depends on the
        other's, or on how much room the window currently has.

        shrink-0 matters just as much, for a second, independent reason:
        this row is a flex-col child of the card, alongside the button row
        that mounts below it on hover -- and a flex child's default
        flex-shrink:1 means the card is free to *compress* this row below
        its natural content height (44px here, driven by the clock+label
        column) whenever the still-animating, not-yet-tall-enough card
        can't fit both rows at once. Measured this directly: early in the
        transition this row's real height was getting shrunk to 24px, and
        items-center was re-centering the (unrelated) clock within that
        squeezed box, so it visibly climbed back up over ~150ms as the
        card caught up. Turning off shrinking here means the row is always
        rendered at its true height and items-center has nothing left to
        redistribute, regardless of how tall the card currently is.
      */}
      <div
        className={`flex shrink-0 items-center ${
          isMini && hovered ? 'justify-between' : 'justify-center'
        } gap-[var(--dev-top-gap,0.5rem)] overflow-hidden`}
      >
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
          {durationEdit !== null ? (
            // A plain focusable div, not an <input> -- there's no native
            // caret, selection, or typing to borrow here (every keystroke
            // is intercepted and applied by hand, see handleDurationKeyDown
            // above), and a div sidesteps two <input> quirks for free: it
            // needs no explicit width (a div just shrinks to fit its
            // content, same as the read-only clock below), and it has no
            // baseline-alignment gap to work around the way <input> does (a
            // *replaced* element sitting alone in a block container picks
            // up a few px of phantom space above it that a div never has).
            //
            // Rendered as three independently clickable H/M/S spans rather
            // than one string, with the blinking caret placed as a sibling
            // right after whichever one is currently `active` -- that's
            // what makes the caret move to wherever you're actually typing
            // instead of sitting fixed at the end: it's genuinely
            // positioned next to the live field in the DOM (not absolutely
            // positioned over static text), so it relocates for free with
            // ordinary layout the instant `active` changes, whether that's
            // from typing (auto-advance), arrow keys, or a direct click.
            <div
              ref={durationEditRef}
              tabIndex={0}
              role="textbox"
              aria-label="Timer duration"
              onKeyDown={handleDurationKeyDown}
              onBlur={commitDurationEdit}
              className={`no-drag inline-flex cursor-text select-none whitespace-nowrap bg-transparent font-mono tabular-nums leading-none shadow-[0_1px_0_0_color-mix(in_srgb,var(--color-ink)_40%,transparent)] focus:shadow-[0_1px_0_0_var(--color-accent-bright)] focus:outline-none ${accent} ${
                isMini ? 'text-2xl' : 'text-base'
              }`}
            >
              {DURATION_SEGMENTS.map((key, i) => (
                // inline-flex here (default align-items:stretch) is what
                // lets the caret span, which sets no height of its own,
                // automatically fill the exact height of the digit next to
                // it -- no separate caret height to keep in sync across
                // mini/floating's different font sizes.
                <span key={key} className="inline-flex">
                  {i > 0 ? <span className="mx-px">:</span> : null}
                  {/* px-1 (rather than the read-only clock's tight fit) is
                      the actual "bigger while editing" request -- it gives
                      each field, and the active one's highlight box
                      especially, some breathing room instead of the digits
                      butting straight up against the colon/caret. Safe to
                      add now in a way it wasn't for the old buffer design:
                      all three fields are always shown here (no segment
                      ever disappears mid-edit the way the hour group does
                      in the read-only formatClock() display), so this
                      padding is constant, not something that pops in and
                      out and re-triggers the "moves while editing" bug. */}
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      focusDurationSegment(i)
                    }}
                    className={`px-1 ${durationEdit.active === i ? 'rounded-sm bg-ink/10' : ''}`}
                  >
                    {durationEdit[key]}
                  </span>
                  {durationEdit.active === i ? (
                    <span aria-hidden="true" className="w-[0.1em] shrink-0 animate-caret-blink bg-current" />
                  ) : null}
                </span>
              ))}
            </div>
          ) : (
            <div
              onClick={startEditingDuration}
              title={canEditDuration ? 'Click to set the duration' : undefined}
              className={`font-mono tabular-nums whitespace-nowrap leading-none ${accent} ${
                isMini ? 'text-2xl' : 'text-base'
              } ${canEditDuration ? 'no-drag cursor-text hover:opacity-80' : ''}`}
            >
              {formatClock(remainingMs)}
            </div>
          )}
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
            {/* Once running/paused there's nothing left for this slot to
                toggle -- mode-switching needs a reset first anyway (see
                canSwitchTimerMode above) -- so it becomes the reset action
                itself instead of just sitting there disabled. Resetting
                brings state back to idle, which flips canSwitchTimerMode
                back to true and turns this back into the mode toggle. */}
            {canSwitchTimerMode ? (
              <IconButton
                title={isStopwatch ? 'Switch to timer' : 'Switch to stopwatch'}
                onClick={toggleTimerMode}
                className={`size-6 ${isStopwatch ? 'text-accent-bright' : ''}`}
              >
                {isStopwatch ? <StopwatchIcon className="size-3.5" /> : <TimerIcon className="size-3.5" />}
              </IconButton>
            ) : (
              <IconButton title="Reset" onClick={reset} className="size-6">
                <ResetIcon className="size-3.5" />
              </IconButton>
            )}
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

      {/* ---------- mini mode: controls row, dropping in from below ---------- */}
      {!isMini ? (
        // justify-content is an inline style, not a Tailwind class, on
        // purpose: Tailwind's arbitrary-value scanner never actually
        // generated justify-[var(--dev-controls-justify,center)] (confirmed
        // by grepping the compiled CSS -- it's simply absent), apparently
        // because it can't type-infer a keyword property's value out of an
        // opaque var() expression the way it can for a length like
        // gap-[var(--dev-icon-gap,0.125rem)] on this same element, which
        // compiles fine. The row was silently never actually centered as a
        // result. A plain inline style needs no such inference -- the
        // browser resolves the var()-with-fallback itself, natively.
        //
        // Always mounted now, rather than gated on `hovered` -- unmounting
        // it instantly on mouse-out was the abrupt "buttons just vanish"
        // half of the old jump/pop combo. Fading its opacity instead means
        // it's still in the layout (and pinned at the same mt- offset) the
        // whole time; overflow-hidden on the card clips it once the window
        // has shrunk past it, so there's no dead space to account for in
        // the compact size. pointer-events-none while hidden keeps it from
        // eating clicks/hover through the invisible buttons.
        <div
          className={`mt-[var(--dev-controls-margin-top,0.625rem)] flex items-center gap-[var(--dev-icon-gap,0.125rem)] transition-opacity duration-200 ${
            hovered ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          style={{ justifyContent: 'var(--dev-controls-justify, center)' }}
        >
          <IconButton
            title={running ? 'Pause' : isStopwatch ? 'Start stopwatch' : 'Start'}
            onClick={toggle}
            className="size-6"
          >
            {running ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
          </IconButton>
          {/* Same swap as the floating row's inline icon above: once
              running/paused, mode-switching is off the table until a
              reset anyway, so this slot becomes the reset action itself
              rather than sitting there disabled. */}
          {canSwitchTimerMode ? (
            <IconButton
              title={isStopwatch ? 'Switch to timer' : 'Switch to stopwatch'}
              onClick={toggleTimerMode}
              className={`size-6 ${isStopwatch ? 'text-accent-bright' : ''}`}
            >
              {isStopwatch ? <StopwatchIcon className="size-3.5" /> : <TimerIcon className="size-3.5" />}
            </IconButton>
          ) : (
            <IconButton title="Reset" onClick={reset} className="size-6">
              <ResetIcon className="size-3.5" />
            </IconButton>
          )}
        {/*   <IconButton title="Settings" onClick={() => api.openSettings()} className="size-6">
            <GearIcon className="size-3.5" />
          </IconButton> */}
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
      {isMini ? (
        <div
          className={`mt-[var(--dev-controls-margin-top,0.625rem)] flex items-center gap-[var(--dev-transport-gap,0.5rem)] transition-opacity duration-200 ${
            hovered ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
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
