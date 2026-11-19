import { useEffect, useRef, useState } from 'react'
import { FACTORY, dubBox } from '../engine/dubbox'
import { SFX } from '../engine/soundsystem'
import { useStore } from '../store'

/**
 * Choose what FIRE plays without leaving the rack: presets, the DJ's own presets,
 * the app's sound-system effects, a file, or a surprise.
 */
export function DubSoundMenu() {
  const d = useStore(dubBox)
  const [open, setOpen] = useState(false)
  // The rack slides sideways (it clips what leaves it): the menu is placed on the page, under the button.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const current = d.preset ?? ((d.patch.voice === 'sample' && d.patch.sampleName) || 'Edited')

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  const choose = (run: () => void) => {
    run()
    setOpen(false)
  }

  return (
    <div className="dbx-menu" ref={root}>
      <button
        className="dbx-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ top: r.bottom + 8, left: r.left + r.width / 2 })
          setOpen(!open)
        }}
        title="Pick the FIRE sound"
      >
        <span>{current}</span>
        <svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          className="dbx-pop"
          role="menu"
          style={
            at
              ? { position: 'fixed', top: at.top, left: Math.max(250, Math.min(window.innerWidth - 250, at.left)), bottom: 'auto' }
              : undefined
          }
        >
          <h5>Presets</h5>
          <div className="dbx-pop-grid">
            {FACTORY.map((x) => (
              <button
                key={x.name}
                role="menuitemradio"
                aria-checked={d.preset === x.name}
                className={d.preset === x.name ? 'on' : ''}
                onClick={() => choose(() => dubBox.usePreset(x.name))}
              >
                {x.name}
              </button>
            ))}
          </div>
          {d.user.length > 0 && <h5>Yours</h5>}
          <div className="dbx-pop-grid">
            {d.user.map((x) => (
              <button
                key={x.name}
                role="menuitemradio"
                aria-checked={d.preset === x.name}
                className={d.preset === x.name ? 'on' : ''}
                onClick={() => choose(() => dubBox.usePreset(x.name))}
              >
                {x.name}
              </button>
            ))}
          </div>
          <h5>Sounds</h5>
          <div className="dbx-pop-grid">
            {SFX.filter((x) => x.id !== 'siren').map((x) => {
              const on = d.preset === null && d.patch.sample === 'sfx:' + x.id
              return (
                <button
                  key={x.id}
                  role="menuitemradio"
                  aria-checked={on}
                  className={on ? 'on' : ''}
                  onClick={() => choose(() => void dubBox.useSfx(x.id))}
                >
                  {x.label}
                </button>
              )
            })}
          </div>
          <div className="dbx-pop-foot">
            <button role="menuitem" onClick={() => picker.current?.click()}>
              Your file…
            </button>
            <button role="menuitem" onClick={() => choose(() => dubBox.surprise())}>
              Surprise
            </button>
          </div>
          <input
            ref={picker}
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void dubBox.loadSampleFile(file)
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}
