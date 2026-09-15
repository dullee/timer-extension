/** `5:04`, or `1:05:04` once there are hours to show. */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Human duration for settings copy: "25 min", "1 h 30 min". */
export function formatDurationLabel(ms) {
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function splitDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60
  }
}

export function joinDuration({ hours = 0, minutes = 0, seconds = 0 }) {
  return ((Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60 + (Number(seconds) || 0)) * 1000
}

export const PRESETS = [
  { label: '5 min', ms: 5 * 60 * 1000 },
  { label: '10 min', ms: 10 * 60 * 1000 },
  { label: '15 min', ms: 15 * 60 * 1000 },
  { label: '25 min', ms: 25 * 60 * 1000 },
  { label: '45 min', ms: 45 * 60 * 1000 },
  { label: '60 min', ms: 60 * 60 * 1000 }
]
