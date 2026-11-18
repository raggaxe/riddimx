import { useEffect, useRef, useState } from 'react'
import { spotify } from '../engine/spotify'
import { deckA, deckB, type Deck } from '../engine/deck'
import { library } from '../library'
import { useStore } from '../store'
import { ui } from '../ui'

interface Track {
  id: string
  title: string
  artist: string
  album: string
  duration: number // seconds
  cover: string | null
}

const clock = (s: number) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')

/** Copies text and says so for a moment on the button. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1400)
        })
      }}
    >
      {done ? 'Copiado' : 'Copiar'}
    </button>
  )
}

/**
 * Spotify: setting up the account (once), then searching the catalogue and sending tracks
 * to the library or straight to a deck.
 */
export function SpotifyPanel() {
  const s = useStore(spotify)
  const [me, setMe] = useState<{ name: string; premium: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Track[]>([])
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const asked = useRef(0)
  const added = useStore(library).entries

  useEffect(() => {
    if (!s.loggedIn) return
    spotify
      .api('GET', '/me')
      .then((u) => setMe({ name: u?.display_name || u?.id || 'Conta Spotify', premium: u?.product === 'premium' }))
      .catch(() => setMe(null))
  }, [s.loggedIn])

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const q = query.trim()
    if (!s.loggedIn || q.length < 2) {
      setResults([])
      setFailed(null)
      return
    }
    const ticket = ++asked.current
    const timer = window.setTimeout(async () => {
      setSearching(true)
      try {
        const json = await spotify.api('GET', '/search?type=track&limit=30&q=' + encodeURIComponent(q))
        if (ticket !== asked.current) return
        setResults(
          (json?.tracks?.items ?? []).map((t: any) => ({
            id: t.id,
            title: t.name,
            artist: (t.artists ?? []).map((a: any) => a.name).join(', '),
            album: t.album?.name ?? '',
            duration: (t.duration_ms ?? 0) / 1000,
            cover: t.album?.images?.at(-1)?.url ?? null,
          })),
        )
        setFailed(null)
      } catch (e) {
        if (ticket === asked.current) setFailed((e as Error).message)
      } finally {
        if (ticket === asked.current) setSearching(false)
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, s.loggedIn])

  /** Adds the track to the library (once), then loads it on a deck if one is given. */
  const send = (t: Track, deck: Deck | null) => {
    const entry = library.addLink('https://open.spotify.com/track/' + t.id)
    if (entry && deck) library.load(entry, deck)
  }
  const inLibrary = (id: string) => added.some((e) => e.kind === 'spotify' && e.ref === id)

  if (!s.loggedIn) {
    return (
      <div className="spot">
        <section className="spot-setup">
          <h5>Spotify não conectado</h5>
          <p className="empty">A conta do Spotify se conecta uma vez, nos Ajustes. Depois a busca aparece aqui.</p>
          <button className="btn" onClick={() => ui.openSettings('contas')}>
            Conectar em Ajustes › Contas
          </button>
        </section>
      </div>
    )
  }

  return (
    <div className="spot on">
      <section className="spot-main">
        <div className="lib-bar">
          <label className="lib-search">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M7 12A5 5 0 107 2a5 5 0 000 10zM10.5 10.5L14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <input
              type="search"
              value={query}
              placeholder="Procurar no Spotify: música, artista, álbum"
              aria-label="Procurar no Spotify"
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
            {searching && <span className="spot-busy">procurando…</span>}
          </label>
        </div>
        {failed && <p className="deck-msg error">{failed}</p>}
        <div className="lib-tracks spot-results">
          {results.length === 0 ? (
            <p className="empty">
              {query.trim().length < 2
                ? 'Digite para buscar. A / B toca no deck, + salva na biblioteca, duplo clique carrega no deck livre.'
                : searching
                  ? ''
                  : 'Nada encontrado.'}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="spot-cover" aria-label="Capa" />
                  <th className="c-title">Título</th>
                  <th className="c-artist">Artista</th>
                  <th className="spot-album">Álbum</th>
                  <th className="c-num">Tempo</th>
                  <th className="c-act" aria-label="Ações" />
                </tr>
              </thead>
              <tbody>
                {results.map((t) => {
                  const saved = inLibrary(t.id)
                  return (
                    <tr
                      key={t.id}
                      onDoubleClick={() => {
                        const entry = library.addLink('https://open.spotify.com/track/' + t.id)
                        if (entry) library.loadFree(entry, deckA, deckB)
                      }}
                    >
                      <td className="spot-cover">{t.cover && <img src={t.cover} alt="" loading="lazy" />}</td>
                      <td className="c-title">{t.title}</td>
                      <td className="c-artist">{t.artist}</td>
                      <td className="spot-album">{t.album}</td>
                      <td className="c-num">{clock(t.duration)}</td>
                      <td className="c-act">
                        <button className="row-btn a" onClick={() => send(t, deckA)} aria-label={'Tocar no deck A: ' + t.title}>
                          A
                        </button>
                        <button className="row-btn b" onClick={() => send(t, deckB)} aria-label={'Tocar no deck B: ' + t.title}>
                          B
                        </button>
                        <button
                          className={'row-btn' + (saved ? ' saved' : '')}
                          disabled={saved}
                          onClick={() => send(t, null)}
                          aria-label={saved ? 'Já está na biblioteca' : 'Salvar na biblioteca: ' + t.title}
                          title={saved ? 'Já está na biblioteca' : 'Salvar na biblioteca'}
                        >
                          {saved ? '✓' : '+'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <aside className="spot-side">
        <h5>Conta</h5>
        <p className="spot-account">
          <i className={'dot' + (s.ready ? ' on' : '')} aria-hidden="true" />
          <span>
            <b>{me?.name ?? 'Conectada'}</b>
            <small>
              {me && !me.premium ? 'Sem Premium: não toca nos decks' : s.ready ? 'Player pronto' : 'Player liga ao tocar a primeira faixa'}
            </small>
          </span>
        </p>
        <button className="btn small" onClick={() => ui.openSettings('contas')}>
          Conta em Ajustes
        </button>
        {s.error && <p className="deck-msg error">{s.error}</p>}
      </aside>
    </div>
  )
}

/** Ajustes › Contas: connecting the Spotify account (once), and the account once it is connected. */
export function SpotifyAccount() {
  const s = useStore(spotify)
  const [clientId, setClientId] = useState(s.clientId)
  const [me, setMe] = useState<{ name: string; premium: boolean } | null>(null)

  useEffect(() => {
    if (!s.loggedIn) return
    spotify
      .api('GET', '/me')
      .then((u) => setMe({ name: u?.display_name || u?.id || 'Conta Spotify', premium: u?.product === 'premium' }))
      .catch(() => setMe(null))
  }, [s.loggedIn])

  if (s.loggedIn) {
    return (
      <div className="spot spot-acc">
        <section className="spot-setup">
          <h5>Spotify</h5>
          <p className="spot-account">
            <i className={'dot' + (s.ready ? ' on' : '')} aria-hidden="true" />
            <span>
              <b>{me?.name ?? 'Conectada'}</b>
              <small>
                {me && !me.premium ? 'Sem Premium: não toca nos decks' : s.ready ? 'Player pronto' : 'Player liga ao tocar a primeira faixa'}
              </small>
            </span>
          </p>
          <button className="btn small" onClick={() => spotify.logout()}>
            Desconectar conta
          </button>
          {s.error && <p className="deck-msg error">{s.error}</p>}
        </section>
        <Limits />
      </div>
    )
  }

    return (
      <div className="spot">
        <section className="spot-setup">
          <h5>Conectar o Spotify (uma vez)</h5>
          <ol className="spot-steps">
            <li>
              <span>
                Crie uma app em{' '}
                <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
                  developer.spotify.com/dashboard
                </a>
                . Precisa de conta Premium.
              </span>
            </li>
            <li>
              <span>
                Em <b>Redirect URIs</b> adicione exatamente:
              </span>
              <code>{spotify.redirectUri}</code>
              <CopyButton text={spotify.redirectUri} />
            </li>
            <li>
              <span>
                Em <b>APIs used</b> marque <b>Web API</b> e <b>Web Playback SDK</b>.
              </span>
            </li>
            <li>
              <span>Cole o Client ID da app e conecte a conta.</span>
            </li>
          </ol>
          <form
            className="spot-login"
            onSubmit={(e) => {
              e.preventDefault()
              spotify.setClientId(clientId)
              void spotify.login()
            }}
          >
            <input
              value={clientId}
              placeholder="Client ID"
              aria-label="Client ID da sua app Spotify"
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value)}
            />
            <button className="btn" disabled={!clientId.trim()}>
              Conectar conta
            </button>
          </form>
          {s.error && <p className="deck-msg error">{s.error}</p>}
        </section>
        <Limits />
      </div>
    )
}

function Limits() {
  return (
    <div className="spot-limits">
      <h5>Limites do Spotify</h5>
      <p>Áudio protegido: num deck Spotify só há play, cue, loops e volume (sem pitch, EQ nem onda).</p>
      <p>Só toca uma faixa Spotify de cada vez.</p>
      <p>As regras do Spotify não permitem misturar as faixas em apps distribuídas: uso pessoal.</p>
    </div>
  )
}
