/**
 * Circular countdown indicator. Drawn with a stroke-dashoffset on an SVG
 * circle rather than a conic-gradient so the cap stays round and it renders
 * identically on both platforms.
 */
export default function ProgressRing({ progress = 0, size = 40, stroke = 3, children, className = '' }) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, progress))

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-white/15"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          className="text-accent-bright transition-[stroke-dashoffset] duration-200 ease-linear"
        />
      </svg>
      {children ? (
        <div className="absolute inset-0 grid place-items-center">{children}</div>
      ) : null}
    </div>
  )
}
