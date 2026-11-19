import { useEffect, useRef } from 'react'
import { decks } from '../engine/deck'

/**
 * Beat counter, one row of four boxes per deck: the box of the beat playing lights up in the deck's
 * colour, and it goes back to the first one on each bar. Follows the same one as the bar lines.
 */
export function BeatCounter() {
  const rows = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    let frame = 0
    const shown = [-2, -2]
    const draw = () => {
      decks.forEach((deck, lane) => {
        const s = deck.get()
        let now = -1 // no grid: all off
        if (s.kind !== 'none' && s.bpm && s.anchor !== null) {
          const beat = 60 / s.bpm
          const k = Math.floor((deck.getPosition() - (s.barAt ?? s.anchor)) / beat + 0.02)
          now = ((k % 4) + 4) % 4
        }
        const row = rows.current[lane]
        if (!row || shown[lane] === now) return
        shown[lane] = now
        row.classList.toggle('nogrid', now < 0)
        Array.from(row.children).forEach((box, i) => box.classList.toggle('on', i === now))
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="beat-count" aria-hidden="true" title="Bar position on each deck (1 to 4)">
      {['a', 'b'].map((name, lane) => (
        <div key={name} className={'bc-row ' + name} ref={(el) => void (rows.current[lane] = el)}>
          <i />
          <i />
          <i />
          <i />
        </div>
      ))}
    </div>
  )
}
