/* eslint-disable @typescript-eslint/no-explicit-any */
import { detectTempo, type Tempo } from './analyze'

/**
 * BPM for a streaming track without access to its audio:
 * find the same song in public music catalogues (Deezer, iTunes), download their free 30-second
 * preview clip, and run our own tempo analysis on that real audio.
 * Only the song title/artist is sent to those services.
 */

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** "ARTIST & Guest - Song (Official Video) [4K]" → { artist: "ARTIST", track: "Song" } */
export function parseTitle(title: string, author = ''): { artist: string; track: string } {
  let t = title.replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, ' ').split(/\s[|｜]\s/)[0]
  t = t
    .replace(/\s*(official|oficial)?\s*(music\s+)?(videoclipe|video|clipe|lyric video|lyrics|audio|áudio|visualizer)\s*(oficial|official)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const parts = t.split(/\s[-–—]\s/)
  let artist: string
  let track: string
  if (parts.length >= 2) {
    artist = parts[0]
    track = parts.slice(1).join(' ')
  } else {
    artist = author.replace(/\s*-\s*Topic$|\s*VEVO$/i, '')
    track = t
  }
  track = track
    .replace(/\s(feat\.?|ft\.?|part\.?)\s.*$/i, '')
    .replace(/["“”]/g, '')
    .trim()
  const lead = artist.split(/\s(?:&|x|e|feat\.?|ft\.?)\s|,/i)[0].trim()
  return { artist: lead, track }
}

interface Candidate {
  title: string
  artist: string
  preview: string
}

function jsonp(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const cb = 'vxJsonp' + Math.random().toString(36).slice(2)
    const script = document.createElement('script')
    const w = window as any
    const finish = () => {
      clearTimeout(timer)
      delete w[cb]
      script.remove()
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error('timeout'))
    }, 8000)
    w[cb] = (data: unknown) => {
      finish()
      resolve(data)
    }
    script.onerror = () => {
      finish()
      reject(new Error('network'))
    }
    script.src = `${url}&output=jsonp&callback=${cb}`
    document.head.appendChild(script)
  })
}

async function deezer(query: string): Promise<Candidate[]> {
  const json = await jsonp('https://api.deezer.com/search?limit=5&q=' + encodeURIComponent(query))
  return (json?.data || []).map((t: any) => ({ title: t.title, artist: t.artist?.name || '', preview: t.preview }))
}

async function itunes(query: string): Promise<Candidate[]> {
  const term = encodeURIComponent(query)
  // Catalogues differ per store: try the default one, then Brazil's.
  for (const country of ['', '&country=BR']) {
    const res = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${term}${country}`)
    if (!res.ok) continue
    const json = await res.json()
    const found: Candidate[] = (json?.results || []).map((t: any) => ({
      title: t.trackName,
      artist: t.artistName,
      preview: t.previewUrl,
    }))
    if (found.length) return found
  }
  return []
}

let decoder: OfflineAudioContext | null = null

async function tempoOfPreview(url: string): Promise<Tempo | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  decoder ??= new OfflineAudioContext(1, 44100, 44100)
  const buffer = await decoder.decodeAudioData(await res.arrayBuffer())
  return detectTempo(buffer, true)
}

export interface LookupResult extends Tempo {
  source: string
  match: string
}

/** Looks the song up in each catalogue and returns the most confident tempo, or null if not found. */
export async function findBpm(title: string, author = ''): Promise<LookupResult | null> {
  const { artist, track } = parseTitle(title, author)
  const words = norm(track)
    .split(' ')
    .filter((w) => w.length > 1)
  if (!words.length) return null
  const haystack = norm(title + ' ' + author)

  /** Same song? Most title words must match, and the catalogue artist must appear in the video title/channel. */
  const matches = (c: Candidate): boolean => {
    if (!c.preview) return false
    const candidateTitle = norm(c.title)
    const hit = words.filter((w) => candidateTitle.includes(w)).length / words.length
    const artistOk = norm(c.artist)
      .split(' ')
      .some((w) => w.length > 2 && haystack.includes(w))
    return hit >= 0.6 && artistOk
  }

  const fromSource = async (name: string, search: (q: string) => Promise<Candidate[]>): Promise<LookupResult | null> => {
    try {
      const candidate = (await search(`${artist} ${track}`.trim())).find(matches)
      if (!candidate) return null
      const tempo = await tempoOfPreview(candidate.preview)
      return tempo && { ...tempo, source: name, match: `${candidate.artist} - ${candidate.title}` }
    } catch {
      return null
    }
  }

  const found = (await Promise.all([fromSource('Deezer', deezer), fromSource('iTunes', itunes)])).filter(
    (r): r is LookupResult => r !== null,
  )
  if (!found.length) return null
  found.sort((a, b) => b.confidence - a.confidence)
  const best = found[0]
  // Real music scores ~0.08–0.5 here; tracks without a steady beat fall below and are left to TAP.
  if (best.confidence < 0.07) return null
  const other = found[1]
  if (other && Math.abs(other.bpm - best.bpm) / best.bpm < 0.015) {
    // Two independent clips agree: their average is closer to the truth than either.
    const mean = (best.bpm + other.bpm) / 2
    const bpm = Math.abs(mean - Math.round(mean)) < 0.2 ? Math.round(mean) : Math.round(mean * 10) / 10
    return { ...best, bpm, source: `${best.source} + ${other.source}` }
  }
  return best
}

/**
 * Album cover for a track with none in its file: the first Deezer match (same catalogue the BPM
 * lookup uses), as a picture URL, or null.
 */
export async function findCover(title: string, author = ''): Promise<string | null> {
  const { artist, track } = parseTitle(title, author)
  const query = (artist ? artist + ' ' : '') + track
  if (query.trim().length < 3) return null
  try {
    const json = await jsonp('https://api.deezer.com/search?limit=3&q=' + encodeURIComponent(query))
    const hit = (json?.data || []).find((t: any) => t?.album?.cover_medium)
    return hit?.album?.cover_medium ?? null
  } catch {
    return null
  }
}
