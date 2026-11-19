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
      {done ? 'Copied' : 'Copy'}
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
      .then((u) => setMe({ name: u?.display_name || u?.id || 'Spotify account', premium: u?.product === 'premium' }))
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
          <h5>Spotify not connected</h5>
          <p className="empty">The Spotify account connects once, in Settings. Then search shows up here.</p>
          <button className="btn" onClick={() => ui.openSettings('contas')}>
            Connect in Settings › Accounts
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
              placeholder="Search Spotify: track, artist, album"
              aria-label="Search Spotify"
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
            {searching && <span className="spot-busy">searching…</span>}
          </label>
        </div>
        {failed && <p className="deck-msg error">{failed}</p>}
        <div className="lib-tracks spot-results">
          {results.length === 0 ? (
            <p className="empty">
              {query.trim().length < 2
                ? 'Type to search. A / B plays on the deck, + saves to the library, double-click loads on the free deck.'
                : searching
                  ? ''
                  : 'Nothing found.'}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="spot-cover" aria-label="Cover" />
                  <th className="c-title">Title</th>
                  <th className="c-artist">Artist</th>
                  <th className="spot-album">Album</th>
                  <th className="c-num">Time</th>
                  <th className="c-act" aria-label="Actions" />
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
                        <button className="row-btn a" onClick={() => send(t, deckA)} aria-label={'Play on deck A: ' + t.title}>
                          A
                        </button>
                        <button className="row-btn b" onClick={() => send(t, deckB)} aria-label={'Play on deck B: ' + t.title}>
                          B
                        </button>
                        <button
                          className={'row-btn' + (saved ? ' saved' : '')}
                          disabled={saved}
                          onClick={() => send(t, null)}
                          aria-label={saved ? 'Already in the library' : 'Save to library: ' + t.title}
                          title={saved ? 'Already in the library' : 'Save to library'}
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
        <h5>Account</h5>
        <p className="spot-account">
          <i className={'dot' + (s.ready ? ' on' : '')} aria-hidden="true" />
          <span>
            <b>{me?.name ?? 'Connected'}</b>
            <small>
              {me && !me.premium ? 'No Premium: won\'t play on the decks' : s.ready ? 'Player ready' : 'Player starts when the first track plays'}
            </small>
          </span>
        </p>
        <button className="btn small" onClick={() => ui.openSettings('contas')}>
          Account in Settings
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
      .then((u) => setMe({ name: u?.display_name || u?.id || 'Spotify account', premium: u?.product === 'premium' }))
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
              <b>{me?.name ?? 'Connected'}</b>
              <small>
                {me && !me.premium ? 'No Premium: won\'t play on the decks' : s.ready ? 'Player ready' : 'Player starts when the first track plays'}
              </small>
            </span>
          </p>
          <button className="btn small" onClick={() => spotify.logout()}>
            Disconnect account
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
          <h5>Connect Spotify (once)</h5>
          <ol className="spot-steps">
            <li>
              <span>
                Create an app at{' '}
                <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
                  developer.spotify.com/dashboard
                </a>
                . Needs a Premium account.
              </span>
            </li>
            <li>
              <span>
                Em <b>Redirect URIs</b> add exactly:
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
              <span>Paste the app's Client ID and connect the account.</span>
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
              aria-label="Your Spotify app's Client ID"
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value)}
            />
            <button className="btn" disabled={!clientId.trim()}>
              Connect account
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
      <h5>Spotify limits</h5>
      <p>Protected audio: a Spotify deck only has play, cue, loops and volume (no pitch, EQ or waveform).</p>
      <p>Only one Spotify track plays at a time.</p>
      <p>Spotify's rules don't allow mixing tracks in distributed apps: personal use.</p>
    </div>
  )
}
