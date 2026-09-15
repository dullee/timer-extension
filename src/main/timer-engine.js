import { EventEmitter } from 'node:events'

export const STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  EXPIRED: 'expired' // stopwatch mode never reaches this -- there is nothing to expire
})

export const MODE = Object.freeze({
  TIMER: 'timer',
  STOPWATCH: 'stopwatch'
})

/** How often we recompute the live value for redraw purposes. */
const TICK_MS = 200

/**
 * The single source of truth for the timer, owned by the main process.
 *
 * Supports two modes that share the same start/pause/resume/reset/toggle verbs
 * and the same event contract, so the REST API, tray, and UI don't need a
 * parallel code path for each:
 *
 *   - timer:     counts down from durationMs to zero, then emits 'expired'.
 *   - stopwatch: counts up from zero with no ceiling, until reset.
 *
 * Both are deliberately anchor-based rather than accumulation-based: while
 * running, a single Date.now() anchor plus whatever was already banked is
 * enough to derive the live value. A timer that instead decrements/increments
 * a counter on every interval drifts (setInterval is not punctual) and stops
 * cold when the machine sleeps, because the interval simply doesn't fire.
 * Comparing against a stored anchor gets both cases right for free -- waking
 * from sleep past a timer's deadline expires it immediately, as it should.
 *
 * Switching modes always resets: there is no sensible way to carry a
 * countdown's remaining time into a count-up, so `setMode` intentionally
 * drops whatever was in progress rather than trying to translate it.
 *
 * Emits:
 *   'state'   (snapshot)  on every transition
 *   'tick'    (snapshot)  roughly every 200ms while running
 *   'expired' (snapshot)  once, when a *timer* (never a stopwatch) reaches zero
 */
export class TimerEngine extends EventEmitter {
  #mode = MODE.TIMER
  #state = STATE.IDLE
  #label = ''
  #interval = null

  // timer-mode bookkeeping
  #durationMs = 0
  #remainingMs = 0
  #expiresAt = null

  // stopwatch-mode bookkeeping
  #elapsedMs = 0
  #startedAt = null

  constructor({ defaultDurationMs = 25 * 60 * 1000, defaultMode = MODE.TIMER } = {}) {
    super()
    this.#durationMs = defaultDurationMs
    this.#remainingMs = defaultDurationMs
    this.#mode = defaultMode === MODE.STOPWATCH ? MODE.STOPWATCH : MODE.TIMER
  }

  getState() {
    if (this.#mode === MODE.STOPWATCH) {
      const elapsedMs = this.#currentElapsed()
      return {
        mode: this.#mode,
        state: this.#state,
        durationMs: this.#durationMs, // last configured timer duration; unused while in this mode
        remainingMs: elapsedMs, // mirrors elapsedMs so generic "value to display" call sites need no branch
        elapsedMs,
        label: this.#label,
        expiresAt: null,
        isActive: this.#state === STATE.RUNNING || this.#state === STATE.PAUSED
      }
    }

    return {
      mode: this.#mode,
      state: this.#state,
      durationMs: this.#durationMs,
      remainingMs: this.#currentRemaining(),
      elapsedMs: this.#durationMs - this.#currentRemaining(),
      label: this.#label,
      expiresAt: this.#expiresAt,
      isActive: this.#state === STATE.RUNNING || this.#state === STATE.PAUSED
    }
  }

  /**
   * Starts from zero (stopwatch) or from full duration (timer) -- always a
   * fresh run, never a resume. Pass `mode` to switch modes and start in one
   * call; omitting it starts in whatever mode is already active.
   */
  start({ durationMs, label, mode } = {}) {
    if (mode != null) this.setMode(mode, { silent: true })
    if (label != null) this.#label = String(label)

    if (this.#mode === MODE.STOPWATCH) {
      this.#elapsedMs = 0
      this.#startedAt = Date.now()
      this.#state = STATE.RUNNING
      this.#startInterval()
      this.#emitState()
      return this.getState()
    }

    if (durationMs != null) {
      const parsed = Number(durationMs)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new RangeError('durationMs must be a positive number of milliseconds')
      }
      this.#durationMs = Math.round(parsed)
    }

    this.#remainingMs = this.#durationMs
    this.#expiresAt = Date.now() + this.#remainingMs
    this.#state = STATE.RUNNING
    this.#startInterval()
    this.#emitState()
    return this.getState()
  }

  pause() {
    if (this.#state !== STATE.RUNNING) return this.getState()

    if (this.#mode === MODE.STOPWATCH) {
      this.#elapsedMs = this.#currentElapsed()
      this.#startedAt = null
    } else {
      this.#remainingMs = this.#currentRemaining()
      this.#expiresAt = null
    }

    this.#state = STATE.PAUSED
    this.#stopInterval()
    this.#emitState()
    return this.getState()
  }

  resume() {
    if (this.#state !== STATE.PAUSED) return this.getState()

    if (this.#mode === MODE.STOPWATCH) {
      // Re-anchor so `now - startedAt` reproduces the banked elapsed time.
      this.#startedAt = Date.now() - this.#elapsedMs
    } else {
      this.#expiresAt = Date.now() + this.#remainingMs
    }

    this.#state = STATE.RUNNING
    this.#startInterval()
    this.#emitState()
    return this.getState()
  }

  /** Convenience for UI and tray: one button that does the right thing. */
  toggle() {
    if (this.#state === STATE.RUNNING) return this.pause()
    if (this.#state === STATE.PAUSED) return this.resume()
    return this.start()
  }

  /** Back to a full timer (timer mode) or zero (stopwatch mode). */
  reset() {
    this.#stopInterval()
    if (this.#mode === MODE.STOPWATCH) {
      this.#elapsedMs = 0
      this.#startedAt = null
    } else {
      this.#remainingMs = this.#durationMs
      this.#expiresAt = null
    }
    this.#state = STATE.IDLE
    this.#emitState()
    return this.getState()
  }

  /** Same as reset today, but kept distinct so the REST verbs stay honest. */
  stop() {
    return this.reset()
  }

  /**
   * Switches between counting down and counting up. Always resets -- there is
   * no meaningful way to carry a countdown's remaining time into a count-up
   * (or vice versa), so this intentionally drops whatever was in progress
   * rather than guessing at a translation.
   *
   * `{ silent: true }` skips the 'state' emit, used internally by start() so
   * a mode-switching start only emits once instead of twice.
   */
  setMode(mode, { silent = false } = {}) {
    if (mode !== MODE.TIMER && mode !== MODE.STOPWATCH) {
      throw new RangeError(`mode must be "${MODE.TIMER}" or "${MODE.STOPWATCH}"`)
    }
    if (mode === this.#mode) return this.getState()

    this.#stopInterval()
    this.#mode = mode
    this.#remainingMs = this.#durationMs
    this.#expiresAt = null
    this.#elapsedMs = 0
    this.#startedAt = null
    this.#state = STATE.IDLE

    if (!silent) this.#emitState()
    return this.getState()
  }

  setDuration(durationMs) {
    const parsed = Number(durationMs)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new RangeError('durationMs must be a positive number of milliseconds')
    }
    this.#durationMs = Math.round(parsed)
    // Changing the duration mid-run would be surprising; only idle/expired
    // timers adopt the new length immediately. Harmless to call in stopwatch
    // mode too -- it just banks the value for whenever the user switches back.
    if (
      this.#mode === MODE.TIMER &&
      (this.#state === STATE.IDLE || this.#state === STATE.EXPIRED)
    ) {
      this.#remainingMs = this.#durationMs
      this.#state = STATE.IDLE
    }
    this.#emitState()
    return this.getState()
  }

  setLabel(label) {
    this.#label = label == null ? '' : String(label)
    this.#emitState()
    return this.getState()
  }

  dispose() {
    this.#stopInterval()
    this.removeAllListeners()
  }

  /* ----------------------------------------------------------- internals */

  #currentRemaining() {
    if (this.#state === STATE.RUNNING && this.#expiresAt != null) {
      return Math.max(0, this.#expiresAt - Date.now())
    }
    return this.#remainingMs
  }

  #currentElapsed() {
    if (this.#state === STATE.RUNNING && this.#startedAt != null) {
      return Math.max(0, Date.now() - this.#startedAt)
    }
    return this.#elapsedMs
  }

  #startInterval() {
    this.#stopInterval()
    this.#interval = setInterval(() => this.#onTick(), TICK_MS)
    // Don't let the timer hold the process open on its own.
    this.#interval.unref?.()
  }

  #stopInterval() {
    if (this.#interval) {
      clearInterval(this.#interval)
      this.#interval = null
    }
  }

  #onTick() {
    if (this.#state !== STATE.RUNNING) return

    if (this.#mode === MODE.STOPWATCH) {
      // No ceiling, no expiry -- just keep counting until paused or reset.
      this.emit('tick', this.getState())
      return
    }

    if (this.#currentRemaining() <= 0) {
      this.#stopInterval()
      this.#remainingMs = 0
      this.#expiresAt = null
      this.#state = STATE.EXPIRED
      const snapshot = this.getState()
      this.emit('state', snapshot)
      this.emit('expired', snapshot)
      return
    }

    this.emit('tick', this.getState())
  }

  #emitState() {
    this.emit('state', this.getState())
  }
}
