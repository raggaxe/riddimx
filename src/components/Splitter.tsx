import { useRef } from 'react'
import { defaultLayout, ui, uiScale, type Layout } from '../ui'

/**
 * Horizontal divider between two parts of the window; drag to give one more room.
 * `part` is the height it changes; `sign` is +1 when dragging down makes that part taller.
 */
export function Splitter({ part, sign, label }: { part: keyof Layout; sign: 1 | -1; label: string }) {
  const start = useRef<{ y: number; size: number } | null>(null)
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={0}
      title={label + ' (drag; double-click goes back to default)'}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { y: e.clientY, size: ui.get().layout[part] }
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        // The pointer moves in screen pixels; the layout is in base pixels, before the global scale.
        ui.resize({ [part]: start.current.size + (sign * (e.clientY - start.current.y)) / uiScale() })
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={() => ui.resize({ [part]: defaultLayout()[part] })}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowDown' ? 10 : e.key === 'ArrowUp' ? -10 : 0
        if (step) ui.resize({ [part]: ui.get().layout[part] + sign * step })
      }}
    >
      <i />
    </div>
  )
}
