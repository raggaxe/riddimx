import { useEffect, useRef } from 'react'
import { mixer } from '../engine/mixer'

/** -48 dB … 0 dB mapped to 0…1 of the meter height. */
const toHeight = (peak: number): number => (peak > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(peak) + 48) / 48)) : 0)

/**
 * Segmented peak meter, in quiet greys; only the top segment warms up near the limit.
 * `stereo` shows left and right side by side (the master).
 */
export function Meter({ node, label, stereo = false }: { node: AudioNode; label: string; stereo?: boolean }) {
  const covers = useRef<(HTMLDivElement | null)[]>([])
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctx = mixer.ctx
    const count = stereo ? 2 : 1
    const splitter = stereo ? ctx.createChannelSplitter(2) : null
    if (splitter) node.connect(splitter)
    const analysers = Array.from({ length: count }, (_, i) => {
      const a = ctx.createAnalyser()
      a.fftSize = 1024
      if (splitter) splitter.connect(a, i)
      else node.connect(a)
      return a
    })
    const data = new Float32Array(1024)
    const level = analysers.map(() => 0)
    let hotUntil = 0
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const now = performance.now()
      analysers.forEach((a, i) => {
        a.getFloatTimeDomainData(data)
        let peak = 0
        for (let k = 0; k < data.length; k++) {
          const v = Math.abs(data[k])
          if (v > peak) peak = v
        }
        if (peak >= 0.98) hotUntil = now + 900
        // Rises at once, falls back gently.
        const target = toHeight(peak)
        level[i] = target > level[i] ? target : level[i] * 0.93
        const cover = covers.current[i]
        if (cover) cover.style.transform = `scaleY(${1 - level[i]})`
      })
      box.current?.classList.toggle('clip', now < hotUntil)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      if (splitter) {
        node.disconnect(splitter)
        splitter.disconnect()
      } else analysers.forEach((a) => node.disconnect(a))
    }
  }, [node, stereo])

  return (
    <div className={'meter' + (stereo ? ' stereo' : '')} ref={box} role="img" aria-label={label}>
      {Array.from({ length: stereo ? 2 : 1 }, (_, i) => (
        <div key={i} className="meter-bar" title={stereo ? (i === 0 ? 'Esquerda' : 'Direita') : undefined}>
          <div className="meter-cover" ref={(el) => (covers.current[i] = el)} />
        </div>
      ))}
    </div>
  )
}

/** Reference marks beside a fader or meter: a tick per step, a number on the labelled ones (top to bottom). */
/** Fader ticks with their numbers; `bare` draws the ticks alone, for the fader's other side. */
export function Scale({ marks, className = '', bare = false }: { marks: (string | null)[]; className?: string; bare?: boolean }) {
  return (
    <div className={'scale ' + className + (bare ? ' bare' : '')} aria-hidden="true">
      {marks.map((m, i) => (
        <span key={i} className={m === null ? 'minor' : 'major'}>
          {m !== null && !bare && <b>{m}</b>}
        </span>
      ))}
    </div>
  )
}

/** Channel / master fader marks: 10 at the top down to 0, numbered every 2. */
export const FADER_MARKS = ['10', null, '8', null, '6', null, '4', null, '2', null, '0']

/** Master meter marks in dB, placed where the meter draws those levels (−48 dB at the bottom). */
export const DB_MARKS = ['0', null, null, null, '-12', null, null, null, '-24', null, null, null, null, null, null, null, '-48']
