/**
 * EchoOrb — animated SVG orb. Green pulse when active; red urgent pulse on alert.
 */

interface EchoOrbProps {
  alert?:  boolean
  score?:  number    // 0-100, shown as circular ring
  size?:   number    // px, default 160
}

export function EchoOrb({ alert = false, score = 0, size = 160 }: EchoOrbProps) {
  const mode = 'echo'
  const r      = size / 2
  const cx     = r
  const cy     = r

  // Ring geometry
  const ringR  = r - 12
  const circ   = 2 * Math.PI * ringR
  const dash   = (score / 100) * circ

  // Colors
  const orb = alert
    ? { base: '#ef4444', glow: '#ef4444', ring: '#f87171', speed: '0.7s' }
    : { base: '#22c55e', glow: '#22c55e', ring: '#86efac', speed: '1.4s' }

  const animId = `pulse-${mode}${alert ? '-alert' : ''}`

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="select-none">
      <defs>
        {/* Radial gradient for orb body */}
        <radialGradient id={`orbGrad-${mode}`} cx="40%" cy="35%" r="60%">
          <stop offset="0%"   stopColor={orb.base} stopOpacity="0.9" />
          <stop offset="100%" stopColor={orb.base} stopOpacity="0.2" />
        </radialGradient>

        {/* Blur filter for glow */}
        <filter id={`orbGlow-${mode}`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="8" result="glow" />
          <feMerge><feMergeNode in="glow" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>

        {/* Pulse animation keyframes */}
        {orb.speed !== '0s' && (
          <style>{`
            @keyframes ${animId} {
              0%, 100% { opacity: 0.25; transform: scale(1); }
              50%       { opacity: 0.55; transform: scale(1.08); }
            }
          `}</style>
        )}
      </defs>

      {/* Outer pulsing ring (medium and high only) */}
      {orb.speed !== '0s' && (
        <circle
          cx={cx} cy={cy} r={r - 4}
          fill="none"
          stroke={orb.glow}
          strokeWidth="2"
          opacity="0.3"
          style={{
            animation:        `${animId} ${orb.speed} ease-in-out infinite`,
            transformOrigin: `${cx}px ${cy}px`,
          }}
        />
      )}

      {/* Score progress ring */}
      <circle
        cx={cx} cy={cy} r={ringR}
        fill="none"
        stroke={orb.ring}
        strokeWidth="3"
        opacity="0.2"
      />
      {score > 0 && (
        <circle
          cx={cx} cy={cy} r={ringR}
          fill="none"
          stroke={orb.ring}
          strokeWidth="3"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
          opacity="0.85"
        />
      )}

      {/* Orb body */}
      <circle
        cx={cx} cy={cy} r={r - 18}
        fill={`url(#orbGrad-${mode})`}
        filter={`url(#orbGlow-${mode})`}
      />

      {/* Score number */}
      <text
        x={cx} y={cy + 5}
        textAnchor="middle"
        fontSize={size * 0.22}
        fontWeight="700"
        fontFamily="ui-monospace, monospace"
        fill="white"
        opacity="0.92"
      >
        {score}
      </text>
      <text
        x={cx} y={cy + size * 0.15}
        textAnchor="middle"
        fontSize={size * 0.085}
        fontFamily="ui-monospace, monospace"
        fill="white"
        opacity="0.45"
        letterSpacing="2"
      >
        SCORE
      </text>
    </svg>
  )
}
