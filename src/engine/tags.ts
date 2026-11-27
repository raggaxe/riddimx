/**
 * Title and artist written inside an audio file: MP3 (ID3v2 TIT2 / TPE1, or the old ID3v1 at the end),
 * FLAC and OGG / OPUS (Vorbis comments TITLE / ARTIST), M4A (MP4 "©nam" / "©ART"). When a file has
 * none, a name like "Artist - Title.mp3" gives them. A damaged tag never stops anything.
 */
export interface Tags {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
}

export function tagsOf(file: ArrayBuffer): Tags {
  const b = new Uint8Array(file)
  try {
    return clean(id3(b) ?? vorbisFlac(b) ?? vorbisOgg(b) ?? mp4(b) ?? id3v1(b) ?? {})
  } catch {
    return {}
  }
}

/** "Artist - Title" (also with – or —) from a file name, when the tags say nothing. */
export function tagsFromName(name: string): Tags {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim()
  const m = base.match(/^(?:\d{1,3}[\s.-]+)?(.+?)\s+[-–—]\s+(.+)$/)
  return m ? clean({ artist: m[1], title: m[2] }) : {}
}

function clean(t: Tags): Tags {
  // eslint-disable-next-line no-control-regex
  const tidy = (s?: string) => s?.replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim() || undefined
  return { title: tidy(t.title), artist: tidy(t.artist), album: tidy(t.album), albumArtist: tidy(t.albumArtist) }
}

const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const le32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const utf8 = new TextDecoder('utf-8')
const latin1 = new TextDecoder('latin1')

/** An ID3v2 text frame: first byte says the encoding. */
function id3Text(b: Uint8Array): string {
  const enc = b[0]
  const body = b.subarray(1)
  if (enc === 0) return latin1.decode(body).split('\u0000')[0]
  if (enc === 3) return utf8.decode(body).split('\u0000')[0]
  // UTF-16, with a byte order mark (1) or big-endian without (2)
  let le = enc === 1
  let s = body
  if (s[0] === 0xff && s[1] === 0xfe) (le = true), (s = s.subarray(2))
  else if (s[0] === 0xfe && s[1] === 0xff) (le = false), (s = s.subarray(2))
  return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(s.subarray(0, s.length - (s.length % 2))).split('\u0000')[0]
}

function id3(b: Uint8Array): Tags | null {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null // "ID3"
  const version = b[3]
  const syncsafe = (o: number): number => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]
  const end = Math.min(b.length, 10 + syncsafe(6))
  const idLength = version === 2 ? 3 : 4
  const headerLength = version === 2 ? 6 : 10
  let at = 10
  if (version >= 3 && b[5] & 0x40) at += version === 4 ? syncsafe(10) : u32(b, 10) + 4
  const out: Tags = {}
  let band = ''
  while (at + headerLength < end) {
    const id = String.fromCharCode(...b.subarray(at, at + idLength))
    if (!/^[A-Z0-9]+$/.test(id)) break
    const size = version === 2 ? (b[at + 3] << 16) | (b[at + 4] << 8) | b[at + 5] : version === 4 ? syncsafe(at + 4) : u32(b, at + 4)
    const body = at + headerLength
    if (size <= 0 || body + size > end) break
    const text = () => id3Text(b.subarray(body, body + size))
    if (id === 'TIT2' || id === 'TT2') out.title = text()
    else if (id === 'TPE1' || id === 'TP1') out.artist = text().replace(/\u0000/g, ', ')
    else if (id === 'TPE2' || id === 'TP2') band = text()
    else if (id === 'TALB' || id === 'TAL') out.album = text()
    at = body + size
  }
  if (band) out.albumArtist = band
  if (!out.artist && band) out.artist = band
  return out.title || out.artist || out.album ? out : null
}

/** ID3v1: 128 bytes at the very end, "TAG" + title(30) + artist(30). */
function id3v1(b: Uint8Array): Tags | null {
  const at = b.length - 128
  if (at < 0 || b[at] !== 0x54 || b[at + 1] !== 0x41 || b[at + 2] !== 0x47) return null
  const field = (o: number) => latin1.decode(b.subarray(at + o, at + o + 30)).split('\u0000')[0]
  const t = { title: field(3), artist: field(33), album: field(63) }
  return t.title.trim() || t.artist.trim() ? t : null
}

/** Vorbis comments (FLAC and OGG): vendor, then "KEY=value" lines, little-endian lengths. */
function comments(b: Uint8Array, at: number, end: number): Tags | null {
  let p = at
  p += 4 + le32(b, p) // vendor
  const n = le32(b, p)
  p += 4
  const out: Tags = {}
  for (let i = 0; i < n && p + 4 <= end; i++) {
    const len = le32(b, p)
    p += 4
    const line = utf8.decode(b.subarray(p, Math.min(end, p + len)))
    p += len
    const eq = line.indexOf('=')
    const key = line.slice(0, eq).toUpperCase()
    const value = line.slice(eq + 1)
    if (key === 'TITLE' && !out.title) out.title = value
    else if (key === 'ARTIST') out.artist = out.artist ? out.artist + ', ' + value : value
    else if (key === 'ALBUMARTIST' || key === 'ALBUM ARTIST') out.albumArtist = value
    else if (key === 'ALBUM' && !out.album) out.album = value
  }
  if (!out.artist && out.albumArtist) out.artist = out.albumArtist
  return out.title || out.artist || out.album ? out : null
}

function vorbisFlac(b: Uint8Array): Tags | null {
  if (b.length < 8 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'fLaC') return null
  let at = 4
  for (;;) {
    if (at + 4 > b.length) return null
    const last = b[at] & 0x80
    const type = b[at] & 0x7f
    const length = (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]
    const body = at + 4
    if (type === 4) return comments(b, body, Math.min(b.length, body + length))
    if (last) return null
    at = body + length
  }
}

/** OGG Vorbis / Opus: the comment header sits in the first pages ("\x03vorbis" or "OpusTags"). */
function vorbisOgg(b: Uint8Array): Tags | null {
  if (b.length < 4 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'OggS') return null
  const limit = Math.min(b.length - 8, 1 << 20)
  for (let i = 0; i < limit; i++) {
    if (b[i] === 0x03 && String.fromCharCode(...b.subarray(i + 1, i + 7)) === 'vorbis') return comments(b, i + 7, b.length)
    if (b[i] === 0x4f && String.fromCharCode(...b.subarray(i, i + 8)) === 'OpusTags') return comments(b, i + 8, b.length)
  }
  return null
}

/** M4A: "©nam" / "©ART" atoms in moov › udta › meta › ilst, each with a "data" child holding UTF-8. */
function mp4(b: Uint8Array): Tags | null {
  if (b.length < 12 || String.fromCharCode(b[4], b[5], b[6], b[7]) !== 'ftyp') return null
  const out: Tags = {}
  const read = (name: string): string | undefined => {
    for (let i = 8; i + 24 < b.length; i++) {
      if (b[i] !== 0xa9 || String.fromCharCode(b[i + 1], b[i + 2], b[i + 3]) !== name) continue
      const d = i + 4
      if (String.fromCharCode(b[d + 4], b[d + 5], b[d + 6], b[d + 7]) !== 'data') continue
      const size = u32(b, d)
      if (size < 16 || d + size > b.length) continue
      return utf8.decode(b.subarray(d + 16, d + size))
    }
    return undefined
  }
  out.title = read('nam')
  out.artist = read('ART')
  out.album = read('alb')
  return out.title || out.artist || out.album ? out : null
}
