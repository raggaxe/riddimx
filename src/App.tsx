import { useEffect } from 'react'
import { mixer } from './engine/mixer'
import { deckA, deckB } from './engine/deck'
import { spotify } from './engine/spotify'
import './midi' // MIDI, gamepad and keyboard shortcuts start with the app
import './remote' // the phone controller's server comes back on if it was left on
import { library } from './library'
import { useStore } from './store'
import { DeckView } from './components/DeckView'
import { MixerView } from './components/MixerView'
import { LibraryPanel } from './components/LibraryPanel'
import { MasterPanel } from './components/MasterPanel'
import { EchoUnit, Rack } from './components/Rack'
import { SettingsModal } from './components/SettingsModal'
import { PitchColumn } from './components/PitchColumn'
import { SpotifyPanel } from './components/SpotifyPanel'
import { Splitter } from './components/Splitter'
import { DubBoxPanel } from './components/DubBoxPanel'
import { SamplerPanel } from './components/SamplerPanel'
import { TrackView } from './components/TrackView'
import { TopBar } from './components/TopBar'
import { VoicePanel } from './components/VoicePanel'

import { ui, type Tab } from './ui'

export function App() {
  const { tab, layout } = useStore(ui)
  const setTab = (t: Tab) => ui.open(t)
  const sp = useStore(spotify)

  // A smaller window shrinks the browser first, so the decks and mixer always fit.
  useEffect(() => {
    const fit = () => ui.resize({})
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  useEffect(() => {
    const resume = () => mixer.resume()
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.files.length) library.addFiles(Array.from(e.dataTransfer.files))
    }
    window.addEventListener('pointerdown', resume)
    window.addEventListener('keydown', resume)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('keydown', resume)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const tabButton = (id: Tab, label: string, on?: boolean) => (
    <button className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
      {label}
      {on !== undefined && <i className={'dot' + (on ? ' on' : '')} />}
    </button>
  )

  return (
    <div className="app" style={{ '--track-h': layout.track + 'px', '--bottom-h': layout.bottom + 'px' } as React.CSSProperties}>
      <TopBar />
      <TrackView />
      <Splitter part="track" sign={1} label="Altura das ondas" />
      <Rack />
      <main className="stage">
        <DeckView deck={deckA} other={deckB} />
        <PitchColumn deck={deckA} />
        <MixerView />
        <PitchColumn deck={deckB} />
        <DeckView deck={deckB} other={deckA} />
      </main>
      <Splitter part="bottom" sign={-1} label="Altura da biblioteca" />
      <section className="bottom">
        <nav className="tabs">
          {tabButton('library', 'Biblioteca')}
          {tabButton('sampler', 'Sampler')}
          {tabButton('dubbox', 'Dub Box')}
          {tabButton('echo', 'Eco fita')}
          {tabButton('voice', 'Voz')}
          {tabButton('master', 'Master')}
          {tabButton('spotify', 'Spotify', sp.loggedIn)}
          {/* The open tab's own tools (search, add files…) sit here, on the tab row, not on a row of their own. */}
          <div className="tab-tools" id="tab-tools" />
        </nav>
        <div className="panel">
          {tab === 'library' && <LibraryPanel />}
          {tab === 'sampler' && <SamplerPanel />}
          {tab === 'dubbox' && <DubBoxPanel />}
          {tab === 'echo' && (
            <div className="echo-panel">
              <EchoUnit />
            </div>
          )}
          {tab === 'voice' && (
            <div className="echo-panel">
              <VoicePanel />
            </div>
          )}
          {tab === 'master' && <MasterPanel />}
          {tab === 'spotify' && <SpotifyPanel />}
        </div>
      </section>
      <SettingsModal />
    </div>
  )
}
