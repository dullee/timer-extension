import { useEffect, useState } from 'react'
import { DEV_LAYOUT_FIELDS, DEV_LAYOUT_JUSTIFY_FIELD, toCssText } from '../lib/devLayout.js'
import { useDevLayoutEditor } from '../hooks/useDevLayout.js'
import { CheckIcon, CopyIcon } from './Icons.jsx'

const api = window.timerAPI

const inputClass =
  'rounded-lg border border-border-subtle bg-surface-input px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent'

function Section({ title, description, children }) {
  return (
    <section className="rounded-xl border border-border-subtle bg-surface-raised/60 p-5">
      <h2 className="text-sm font-semibold tracking-wide text-ink uppercase">{title}</h2>
      {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
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

/** One slider row for a spacing field, with its current value and a
 * per-field reset back to the CSS default (removes the override entirely,
 * rather than just resetting to the default *number*, so it goes back to
 * genuinely inheriting from styles.css). */
function SliderRow({ field, value, onChange, onReset }) {
  const current = value ?? field.default
  const isOverridden = value != null

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-ink">{field.label}</div>
          <div className="text-xs text-ink-muted">{field.hint}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="w-14 text-right font-mono text-xs text-ink-muted">
            {current}
            {field.unit}
          </span>
          {isOverridden ? (
            <Button onClick={onReset} className="px-2 py-1 text-xs">
              Reset
            </Button>
          ) : null}
        </div>
      </div>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={current}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`mt-2 w-full accent-[var(--color-accent)] ${isOverridden ? '' : 'opacity-60'}`}
      />
    </div>
  )
}

const OVERLAY_SIZE_ROWS = [
  { mode: 'floating', hovered: false, label: 'Floating -- compact' },
  { mode: 'floating', hovered: true, label: 'Floating -- hover' },
  { mode: 'mini', hovered: false, label: 'Mini -- compact' },
  { mode: 'mini', hovered: true, label: 'Mini -- hover' }
]

function OverlaySizeRow({ row, override, onChange, onReset }) {
  const [width, setWidth] = useState(override?.width ?? '')
  const [height, setHeight] = useState(override?.height ?? '')

  useEffect(() => {
    setWidth(override?.width ?? '')
    setHeight(override?.height ?? '')
  }, [override?.width, override?.height])

  const commit = (w, h) => {
    const width = Number(w)
    const height = Number(h)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      onChange({ width: Math.round(width), height: Math.round(height) })
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm text-ink">{row.label}</div>
      <div className="flex shrink-0 items-center gap-2">
        <input
          type="number"
          placeholder="w"
          value={width}
          onChange={(e) => {
            setWidth(e.target.value)
            commit(e.target.value, height)
          }}
          className={`${inputClass} w-16 text-center font-mono`}
        />
        <span className="text-ink-muted">x</span>
        <input
          type="number"
          placeholder="h"
          value={height}
          onChange={(e) => {
            setHeight(e.target.value)
            commit(width, e.target.value)
          }}
          className={`${inputClass} w-16 text-center font-mono`}
        />
        {override ? (
          <Button onClick={onReset} className="px-2 py-1 text-xs">
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Dev-only window (see settings.isDev / the overlay's wrench button) for
 * live-tweaking the overlay's padding, gaps, margins, one flex property, and
 * its actual pixel dimensions in every mode/hover-state combination.
 *
 * The spacing controls apply instantly to whichever overlay window is open,
 * with no rebuild and no IPC round trip -- see useDevLayout.js for how
 * (localStorage + the cross-window `storage` event). The size controls do go
 * through IPC, since only the main process can call BrowserWindow.setBounds.
 */
export default function DevLayoutWindow() {
  const { values, setField, resetField, resetAll } = useDevLayoutEditor()
  const [sizeOverrides, setSizeOverrides] = useState({})
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api.dev.getOverlaySizeOverrides().then(setSizeOverrides)
  }, [])

  const setSizeOverride = async (mode, hovered, size) => {
    const next = await api.dev.setOverlaySizeOverride(mode, hovered, size)
    setSizeOverrides(next)
  }

  const resetSizeOverrides = async () => {
    await api.dev.resetOverlaySizeOverrides()
    setSizeOverrides({})
  }

  const cssText = toCssText(values)

  const copyCss = async () => {
    if (!cssText) return
    await navigator.clipboard.writeText(cssText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="settings-root h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-2xl space-y-5 px-6 py-8">
        <header>
          <h1 className="text-xl font-semibold text-ink">Dev Layout</h1>
          <p className="text-sm text-ink-muted">
            Live-tunes the overlay window. Dev builds only -- none of this exists in a packaged
            install.
          </p>
        </header>

        <Section
          title="Spacing"
          description="Applies instantly to any open overlay window. Saved to this browser profile (not the app's settings file), so it survives a relaunch but never ships."
        >
          {DEV_LAYOUT_FIELDS.map((field) => (
            <SliderRow
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={(v) => setField(field.key, v)}
              onReset={() => resetField(field.key)}
            />
          ))}

          <div>
            <div className="text-sm text-ink">{DEV_LAYOUT_JUSTIFY_FIELD.label}</div>
            <div className="text-xs text-ink-muted">{DEV_LAYOUT_JUSTIFY_FIELD.hint}</div>
            <select
              value={values[DEV_LAYOUT_JUSTIFY_FIELD.key] ?? DEV_LAYOUT_JUSTIFY_FIELD.default}
              onChange={(e) => setField(DEV_LAYOUT_JUSTIFY_FIELD.key, e.target.value)}
              className={`${inputClass} mt-2 w-full`}
            >
              {DEV_LAYOUT_JUSTIFY_FIELD.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 border-t border-border-subtle pt-4">
            <Button variant="danger" onClick={resetAll}>
              Reset all spacing
            </Button>
            <Button variant="primary" onClick={copyCss} disabled={!cssText} className="flex items-center gap-1.5">
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              {copied ? 'Copied' : 'Copy CSS'}
            </Button>
          </div>

          {cssText ? (
            <pre className="overflow-x-auto rounded-lg bg-surface-input p-3 font-mono text-xs leading-relaxed text-ink-muted">
              {cssText}
            </pre>
          ) : (
            <p className="text-xs text-ink-muted">
              Paste "Copy CSS" into styles.css's @theme block to make a tweak permanent, once
              you've landed on values you like.
            </p>
          )}
        </Section>

        <Section
          title="Window size"
          description="The overlay's actual pixel dimensions per mode and hover state. In-memory only -- resets on the next `npm run dev` relaunch, unlike the spacing values above."
        >
          {OVERLAY_SIZE_ROWS.map((row) => {
            const key = `${row.mode}-${row.hovered ? 'hover' : 'compact'}`
            return (
              <OverlaySizeRow
                key={key}
                row={row}
                override={sizeOverrides[key]}
                onChange={(size) => setSizeOverride(row.mode, row.hovered, size)}
                onReset={() => setSizeOverride(row.mode, row.hovered, null)}
              />
            )
          })}
          <div className="border-t border-border-subtle pt-4">
            <Button variant="danger" onClick={resetSizeOverrides}>
              Reset all sizes
            </Button>
          </div>
          <p className="text-xs text-ink-muted">
            Permanent changes live in OVERLAY_SIZES / OVERLAY_COMPACT_SIZES in src/main/store.js.
          </p>
        </Section>
      </div>
    </div>
  )
}
