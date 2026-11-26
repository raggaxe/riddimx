import { useState } from 'react'
import { DropsPanel } from './DropsPanel'
import { VoicePanel } from './VoicePanel'

type View = 'mic' | 'drops'
const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: 'mic', label: 'Live mic', hint: 'The microphone on air: TALK, level, duck, presets, colour, echo and spring' },
  { id: 'drops', label: 'Drops', hint: 'Make drops and jingles with a voice (the Mac, your mic or a track) and put them on the pads' },
]
const LS_VIEW = 'vx_voice_view'

/**
 * Voice tab: everything done with a voice, live or recorded. LIVE MIC is the microphone on air;
 * DROPS makes jingles with a voice and puts them on the sampler pads.
 */
export function VoiceTab() {
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem(LS_VIEW) as View | null
      return VIEWS.some((v) => v.id === saved) ? saved! : 'mic'
    } catch {
      return 'mic'
    }
  })
  const open = (next: View) => {
    setView(next)
    try {
      localStorage.setItem(LS_VIEW, next)
    } catch {
      /* not remembered */
    }
  }
  return (
    <div className="sp voice-tab">
      <nav className="side-nav" aria-label="Voice sections">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={'side-item' + (view === v.id ? ' active' : '')}
            aria-pressed={view === v.id}
            title={v.hint}
            onClick={() => open(v.id)}
          >
            {v.label}
          </button>
        ))}
      </nav>
      {view === 'mic' && (
        <div className="echo-panel">
          <VoicePanel />
        </div>
      )}
      {view === 'drops' && <DropsPanel />}
    </div>
  )
}
