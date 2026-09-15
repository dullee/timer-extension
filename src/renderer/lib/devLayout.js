/**
 * Dev-only overlay layout tunables -- padding, gaps, margins, and one flex
 * property. Each is backed by a CSS custom property with a default that
 * matches the app's normal hardcoded value exactly (see the matching
 * `var(--x, <default>)` fallback wherever it's consumed in Overlay.jsx), so
 * nothing visually changes for anyone until the Dev Layout window -- dev
 * builds only, gated on `settings.isDev` -- actually touches one.
 *
 * Persisted to localStorage rather than the main settings store: this is
 * developer scratch state, not a user preference, and localStorage is
 * shared across every window in the app (same Electron session, same
 * `file://` origin). That sharing is what lets the Overlay pick up a change
 * live the instant the Dev Layout window writes one -- see useDevLayout.js,
 * which listens for the browser's `storage` event rather than needing any
 * IPC round trip for what is, after all, just CSS.
 */
export const DEV_LAYOUT_STORAGE_KEY = 'timer-dev-layout-v1'

export const DEV_LAYOUT_FIELDS = [
  {
    key: 'cardPaddingX',
    cssVar: '--dev-card-padding-x',
    label: 'Card padding (left/right)',
    hint: 'px-3 on the overlay card',
    unit: 'rem',
    default: 0.75,
    min: 0,
    max: 2,
    step: 0.05
  },
  {
    key: 'topGap',
    cssVar: '--dev-top-gap',
    label: 'Top row gap',
    hint: 'Space between the ring, clock, and inline icons',
    unit: 'rem',
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.05
  },
  {
    key: 'iconGap',
    cssVar: '--dev-icon-gap',
    label: 'Icon button gap',
    hint: 'Between icon buttons, in both icon rows',
    unit: 'rem',
    default: 0.125,
    min: 0,
    max: 1,
    step: 0.025
  },
  {
    key: 'controlsMarginTop',
    cssVar: '--dev-controls-margin-top',
    label: 'Controls row margin-top',
    hint: 'Space above whichever row drops in below the clock',
    unit: 'rem',
    default: 0.625,
    min: 0,
    max: 2,
    step: 0.05
  },
  {
    key: 'labelMarginTop',
    cssVar: '--dev-label-margin-top',
    label: 'Label margin-top',
    hint: 'Clock-to-label spacing (rich layout only)',
    unit: 'rem',
    default: 0.25,
    min: 0,
    max: 1,
    step: 0.05
  },
  {
    key: 'transportGap',
    cssVar: '--dev-transport-gap',
    label: 'Transport buttons gap',
    hint: 'Between the full-width Start and Reset buttons',
    unit: 'rem',
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.05
  }
]

/** The one flex-layout property exposed -- a representative example; add
 * more the same way (a `cssVar`, a fallback in the matching Tailwind
 * arbitrary-value class, and a control here) if you need to tune others. */
export const DEV_LAYOUT_JUSTIFY_FIELD = {
  key: 'controlsJustify',
  cssVar: '--dev-controls-justify',
  label: 'Icon row justify-content',
  hint: 'The below-clock icon row only (floating)',
  default: 'center',
  options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around']
}

export const ALL_DEV_LAYOUT_FIELDS = [...DEV_LAYOUT_FIELDS, DEV_LAYOUT_JUSTIFY_FIELD]

export function loadDevLayout() {
  try {
    const raw = localStorage.getItem(DEV_LAYOUT_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveDevLayout(values) {
  try {
    localStorage.setItem(DEV_LAYOUT_STORAGE_KEY, JSON.stringify(values))
  } catch {
    // Best-effort -- a private window or blocked site data shouldn't crash a
    // developer convenience tool.
  }
}

/** Writes each stored value (or clears it, restoring the CSS fallback) as a
 * custom property on the document root, where every var(--x, default) in
 * Overlay.jsx's classNames picks it up automatically. */
export function applyDevLayout(values) {
  const root = document.documentElement.style
  for (const field of ALL_DEV_LAYOUT_FIELDS) {
    const value = values[field.key]
    if (value == null || value === '') {
      root.removeProperty(field.cssVar)
    } else {
      root.setProperty(field.cssVar, field.unit ? `${value}${field.unit}` : String(value))
    }
  }
}

/** For the Dev Layout window's "Copy CSS" button -- only the fields that
 * have actually been touched, ready to paste into styles.css to make a
 * temporary tweak permanent. */
export function toCssText(values) {
  const lines = ALL_DEV_LAYOUT_FIELDS.filter((f) => values[f.key] != null && values[f.key] !== '').map(
    (f) => `  ${f.cssVar}: ${f.unit ? `${values[f.key]}${f.unit}` : values[f.key]};`
  )
  return lines.length ? `:root {\n${lines.join('\n')}\n}` : ''
}
