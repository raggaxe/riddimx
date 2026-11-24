import { useRef, useState } from 'react'
import { clamp } from '../store'

interface Props {
  label: string
  value: number
  min?: number
  max?: number
  reset?: number
  /** Readout shown in place of the label while the knob is turned (e.g. "+3 dB"). */
  format?: (value: number) => string
  onChange(value: number): void
}

const SWEEP = 270 // degrees from fully left to fully right
const R = 15 // ring radius in the 36×36 viewBox

/** Point on the ring for an angle measured from 12 o'clock, clockwise. */
const at = (deg: number) => {
  const r = ((deg - 90) * Math.PI) / 180
  return [18 + R * Math.cos(r), 18 + R * Math.sin(r)]
}

/** SVG arc between two angles (12 o'clock = 0, clockwise). */
function arc(from: number, to: number): string {
  if (Math.abs(to - from) < 0.5) return ''
  const [a, b] = from < to ? [from, to] : [to, from]
  const [x1, y1] = at(a)
  const [x2, y2] = at(b)
  return `M${x1} ${y1}A${R} ${R} 0 ${b - a > 180 ? 1 : 0} 1 ${x2} ${y2}`
}

/**
 * Rotary control: drag vertically, double-click to reset, arrow keys for fine steps.
 * A thin ring shows how far it is from its resting point; while turned, the label shows the value.
 */
export function Knob({ label, value, min = -1, max = 1, reset = 0, format, onChange }: Props) {
  const drag = useRef<{ y: number; value: number } | null>(null)
  const [active, setActive] = useState(false)
  const span = max - min
  const angleOf = (v: number) => -SWEEP / 2 + ((v - min) / span) * SWEEP
  const angle = angleOf(value)
  const rest = angleOf(reset)
  const moved = Math.abs(value - reset) > span * 0.01

  return (
    <div className={'knob' + (moved ? ' moved' : '')}>
      <div
        className="knob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        title={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={format ? format(value) : undefined}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, value }
          setActive(true)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          onChange(clamp(drag.current.value + ((drag.current.y - e.clientY) / 140) * span, min, max))
        }}
        onPointerUp={() => {
          drag.current = null
          setActive(false)
        }}
        onPointerCancel={() => {
          drag.current = null
          setActive(false)
        }}
        onDoubleClick={() => onChange(reset)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(clamp(value + span / 40, min, max))
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(clamp(value - span / 40, min, max))
        }}
      >
        <svg className="knob-ring" viewBox="0 0 36 36" aria-hidden="true">
          <path className="track" d={arc(-SWEEP / 2, SWEEP / 2)} />
          {moved && <path className="value" d={arc(rest, angle)} />}
        </svg>
        <div className="knob-cap" style={{ transform: `rotate(${angle}deg)` }}>
          <i />
        </div>
      </div>
      {/* The label always keeps its place; the value shows over it while turning, so nothing around moves. */}
      <span className={active && format ? 'reading' : ''}>
        {label}
        {active && format && <b className="knob-readout">{format(value)}</b>}
      </span>
    </div>
  )
}
