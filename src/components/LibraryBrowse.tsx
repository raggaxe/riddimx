import { useMemo } from 'react'
import { covers } from '../covers'
import type { Entry } from '../library'
import { useStore } from '../store'

/** The library seen by artist or by album, as cards (like Spotify's Your Library). */
export type BrowseMode = 'artists' | 'albums'

export interface Group {
  mode: BrowseMode
  key: string
  name: string
  sub: string
}

interface Card extends Group {
  ids: string[]
  cover: string | null
  seconds: number
}

/** "Sly & Robbie, King Tubby feat. U-Roy" → each artist on their own ("&" stays: duos are one name). */
export function artistsOf(e: Entry): string[] {
  // YouTube gives the channel: "Bob Marley - Topic" and "BobMarleyVEVO" are the artist.
  const artist = e.kind === 'youtube' ? e.artist.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/, '') : e.artist
  const names = artist
    .split(/\s*[,;/]\s*|\s+(?:feat\.?|ft\.?|featuring|x|vs\.?|with)\s+|\s*\((?:feat\.?|ft\.?)\s*|\)\s*$/i)
    .map((n) => n.trim())
    .filter(Boolean)
  return names.length ? names : []
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

export const artistKey = (name: string) => fold(name)

export function albumKeyOf(e: Entry): string | null {
  if (!e.album) return null
  return fold(e.album) + '|' + fold(e.albumArtist || artistsOf(e)[0] || '')
}

/** Does this track belong to the open artist / album? */
export function inGroup(e: Entry, g: Group): boolean {
  if (g.mode === 'albums') return albumKeyOf(e) === g.key
  return artistsOf(e).some((n) => artistKey(n) === g.key)
}

const plural = (n: number, one: string) => n + ' ' + (n === 1 ? one : one + 's')

function minutes(s: number): string {
  if (!s) return ''
  const m = Math.round(s / 60)
  return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'
}

export function groupSub(mode: BrowseMode, ids: string[], seconds: number, by?: string): string {
  return [mode === 'albums' && by ? by : '', plural(ids.length, 'track'), minutes(seconds)].filter(Boolean).join(' · ')
}

function cards(mode: BrowseMode, entries: Entry[]): Card[] {
  const map = new Map<string, Card>()
  const add = (key: string, name: string, e: Entry, by?: string) => {
    let c = map.get(key)
    if (!c) {
      c = { mode, key, name, sub: '', ids: [], cover: null, seconds: 0 }
      map.set(key, c)
      if (by) c.sub = by
    }
    c.ids.push(e.id)
    c.seconds += e.duration ?? 0
    c.cover ??= covers.of(e)
  }
  for (const e of entries) {
    if (mode === 'artists') for (const n of artistsOf(e)) add(artistKey(n), n, e)
    else {
      const k = albumKeyOf(e)
      if (k) add(k, e.album!, e, e.albumArtist || artistsOf(e)[0] || '')
    }
  }
  return [...map.values()]
    .map((c) => ({ ...c, sub: groupSub(mode, c.ids, c.seconds, c.sub) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** Two letters for an artist with no picture. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /\w/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')

export function BrowseGrid({
  mode,
  entries,
  words,
  onOpen,
}: {
  mode: BrowseMode
  entries: Entry[]
  words: string[]
  onOpen: (g: Group) => void
}) {
  useStore(covers) // new thumbnails show as they arrive
  const all = useMemo(() => cards(mode, entries), [mode, entries])
  const shown = words.length ? all.filter((c) => words.every((w) => (c.name + ' ' + c.sub).toLowerCase().includes(w))) : all
  const missing = entries.filter((e) => (mode === 'artists' ? !artistsOf(e).length : !albumKeyOf(e))).length

  if (!shown.length) {
    return (
      <p className="empty">
        {words.length
          ? 'Nothing found.'
          : mode === 'artists'
            ? 'No artists yet: they come from the files\' tags, or from names like "Artist - Title".'
            : 'No albums yet: they come from the files\' tags (YouTube links have none).'}
      </p>
    )
  }
  return (
    <div className="lb-wrap">
      <ul className={'lb-grid ' + mode} role="list">
        {shown.map((c) => (
          <li key={c.key}>
            <button className="lb-card" onClick={() => onOpen(c)} title={c.name + ' · ' + c.sub}>
              <span className="lb-art">
                {c.cover ? <img src={c.cover} alt="" loading="lazy" draggable={false} /> : <i aria-hidden="true">{mode === 'artists' ? initials(c.name) : '♪'}</i>}
              </span>
              <b>{c.name}</b>
              <small>{mode === 'artists' ? 'Artist · ' + c.sub : c.sub}</small>
            </button>
          </li>
        ))}
      </ul>
      {missing > 0 && (
        <p className="lb-missing">
          {plural(missing, 'track')} without {mode === 'artists' ? 'an artist' : 'an album'} in {missing === 1 ? 'its' : 'their'} tags: in All.
        </p>
      )}
    </div>
  )
}

/** Top of an open artist / album: picture, name and what is in it, with the way back. */
export function GroupHeader({ group, entries, onBack }: { group: Group; entries: Entry[]; onBack: () => void }) {
  useStore(covers)
  const cover = entries.map((e) => covers.of(e)).find(Boolean) ?? null
  const seconds = entries.reduce((s, e) => s + (e.duration ?? 0), 0)
  const by = group.mode === 'albums' ? entries.find((e) => e.albumArtist)?.albumArtist || artistsOf(entries[0] ?? ({ artist: '' } as Entry))[0] : undefined
  return (
    <div className={'lb-head ' + group.mode}>
      <button className="btn small lb-back" onClick={onBack} aria-label={'Back to ' + (group.mode === 'artists' ? 'artists' : 'albums')}>
        ‹ {group.mode === 'artists' ? 'Artists' : 'Albums'}
      </button>
      <span className="lb-art">{cover ? <img src={cover} alt="" draggable={false} /> : <i aria-hidden="true">{group.mode === 'artists' ? initials(group.name) : '♪'}</i>}</span>
      <span className="lb-title">
        <small>{group.mode === 'artists' ? 'Artist' : 'Album'}</small>
        <b>{group.name}</b>
        <em>{groupSub(group.mode, entries.map((e) => e.id), seconds, by)}</em>
      </span>
    </div>
  )
}
