/**
 * Renderer-side design constants that aren't Tailwind classes -- mainly
 * numeric props handed to components like ProgressRing, which draws an SVG
 * and needs real pixel numbers rather than a className. Everything that CAN
 * be a Tailwind utility lives in styles.css instead (see the tokens grouped
 * under "shape", "density", and "type scale" in the @theme block there);
 * this file is only for the handful of values that can't be.
 *
 * Grouped here so resizing the progress ring, say, is "change one number in
 * this file" rather than "grep for the ProgressRing size prop across every
 * call site and hope you found them all."
 *
 * The other two design-tokens locations: styles.css's @theme block (colors,
 * shape, density, type scale) and src/main/store.js's OVERLAY_SIZES (the
 * overlay window's actual pixel dimensions -- has to live in the main
 * process, which can't see this file or styles.css at all).
 */

/** Progress ring diameter in px, per overlay size. */
export const RING_SIZE = {
  floating: 32,
  mini: 40
}

/** Progress ring stroke width in px -- same for both overlay sizes. */
export const RING_STROKE = 3
