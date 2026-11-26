import { useEffect } from 'react'
import { mixer } from './engine/mixer'
import { deckA, deckB } from './engine/deck'
import { spotify } from './engine/spotify'
import './midi' // MIDI, gamepad and keyboard shortcuts start with the app
import './remote' // the phone controller's server comes back on if it was left on
import './phoneRelay' // …and its link from anywhere, through the RiddimX server
import { library } from './library'
import { useStore } from './store'
import { DeckView } from './components/DeckView'
import { MixerView } from './components/MixerView'
import { LibraryPanel } from './components/LibraryPanel'
import { PluginPanel } from './components/PluginPanel'
import { MasterPanel } from './components/MasterPanel'
import { EchoUnit } from './components/Rack'
import { SettingsModal } from './components/SettingsModal'
import { SpotifyPanel } from './components/SpotifyPanel'
import { Splitter } from './components/Splitter'
import { DubBoxPanel } from './components/DubBoxPanel'
import { SamplerPanel } from './components/SamplerPanel'
import { TrackView } from './components/TrackView'
import { TopBar } from './components/TopBar'
import { GuestPanel } from './components/GuestPanel'
import { VoiceTab } from './components/VoiceTab'

import { SIMPLE_TABS, ui, type Tab } from './ui'
import { padModes } from './padmode'

export function App() {
  const { tab, layout, mode } = useStore(ui)
  const simple = mode === 'simple'
  // Simple mode shows the hot cue pads only.
  useEffect(() => {
    if (!simple) return
    padModes.setMode('A', 'cue')
    padModes.setMode('B', 'cue')
  }, [simple])
  const setTab = (t: Tab) => ui.open(t)
  const sp = useStore(spotify)

  // A resized window keeps its proportions: the library keeps its share, the decks what they need.
  useEffect(() => {
    const fit = () => ui.refit()
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

  const tabButton = (id: Tab, label: string, on?: boolean) =>
    (!simple || SIMPLE_TABS.includes(id)) && (
    <button className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
      {label}
      {on !== undefined && <i className={'dot' + (on ? ' on' : '')} />}
    </button>
  )

  return (
    <div className={'app mode-' + mode} style={{ '--track-h': layout.track + 'px', '--bottom-h': layout.bottom + 'px' } as React.CSSProperties}>
      <TopBar />
      <TrackView />
      <Splitter part="track" sign={1} label="Waveform height" />
      <main className="stage">
        <DeckView deck={deckA} other={deckB} />
        <MixerView />
        <DeckView deck={deckB} other={deckA} />
      </main>
      <Splitter part="bottom" sign={-1} label="Library height" />
      <section className="bottom">
        <nav className="tabs">
          {tabButton('library', 'Library')}
          {tabButton('sampler', 'Sampler')}
          {tabButton('dubbox', 'Dub Box')}
          {tabButton('echo', 'Tape echo')}
          {tabButton('voice', 'Voice')}
          {tabButton('plugin', 'FX')}
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
          {tab === 'voice' && <VoiceTab />}
          {tab === 'plugin' && <PluginPanel />}
          {tab === 'master' && <MasterPanel />}
          {tab === 'spotify' && <SpotifyPanel />}
        </div>
      </section>
      <SettingsModal />
      <GuestPanel />
    </div>
  )
}
