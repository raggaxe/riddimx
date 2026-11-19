import { useEffect, useRef } from 'react'
import { midi } from '../midi'
import { useStore } from '../store'
import { ui, type SettingsPage } from '../ui'
import { AiPanel } from './AiPanel'
import { AudioPanel } from './AudioPanel'
import { DubPanel } from './DubPanel'
import { RewindPanel } from './RewindPanel'
import { SpotifyAccount } from './SpotifyPanel'
import { MidiPanel } from './MidiPanel'
import { SettingsPanel } from './SettingsPanel'
import { PhonePanel } from './PhonePanel'
import { remote } from '../remote'

const PAGES: { id: SettingsPage; label: string; hint: string }[] = [
  { id: 'geral', label: 'Geral', hint: 'Tamanho, cores, jog e pista' },
  { id: 'decks', label: 'Decks', hint: 'Botões DUB e ◀◀ Rewind' },
  { id: 'audio', label: 'Placa de áudio', hint: 'Output master, headphone, input do mic' },
  { id: 'midi', label: 'Controles', hint: 'Controladora MIDI, comando e teclado' },
  { id: 'celular', label: 'Celular', hint: 'O celular vira controladora sem fio' },
  { id: 'contas', label: 'Contas', hint: 'Spotify' },
  { id: 'ia', label: 'Letras e IA', hint: 'Idioma das letras, modelo, stems' },
]

/**
 * Ajustes: a window in front of the app, with its pages on the left. Closes with ×, Esc or a click
 * outside it. While it is open the keyboard shortcuts of the decks rest (except when learning one).
 */
export function SettingsModal() {
  const page = useStore(ui).settings
  const m = useStore(midi)
  const phone = useStore(remote)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!page) return
    const onKey = (e: KeyboardEvent) => {
      // Esc while learning a control only cancels the learning (the MIDI panel handles it).
      if (e.key === 'Escape' && !midi.get().learning) ui.openSettings(null)
    }
    window.addEventListener('keydown', onKey)
    box.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [page])

  if (!page) return null
  const close = () => {
    if (midi.get().learning) midi.learn(null)
    ui.openSettings(null)
  }

  return (
    <div className="sm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sm" role="dialog" aria-modal="true" aria-label="Ajustes" tabIndex={-1} ref={box}>
        <nav className="sm-side" aria-label="Páginas dos ajustes">
          <h2>Ajustes</h2>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={'sm-tab' + (page === p.id ? ' now' : '')}
              aria-current={page === p.id ? 'page' : undefined}
              onClick={() => ui.openSettings(p.id)}
            >
              <b>
                {p.label}
                {p.id === 'midi' && <i className={'dot' + (m.inputs.length ? ' on' : '')} />}
                {p.id === 'celular' && phone.on && <i className={'dot' + (phone.clients ? ' on' : '')} />}
              </b>
              <small>{p.hint}</small>
            </button>
          ))}
        </nav>
        <section className="sm-main">
          <header className="sm-head">
            <h3>{PAGES.find((p) => p.id === page)?.label}</h3>
            <button className="sm-close" onClick={close} aria-label="Fechar" title="Fechar (Esc)">
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </header>
          <div className="sm-body">
            {page === 'geral' && <SettingsPanel />}
            {page === 'audio' && <AudioPanel />}
            {page === 'midi' && <MidiPanel />}
            {page === 'decks' && (
              <div className="sm-decks">
                <DubPanel />
                <RewindPanel />
              </div>
            )}
            {page === 'celular' && <PhonePanel />}
            {page === 'contas' && <SpotifyAccount />}
            {page === 'ia' && <AiPanel />}
          </div>
        </section>
      </div>
    </div>
  )
}
