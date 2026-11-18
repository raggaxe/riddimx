/**
 * Cover picture embedded in an audio file: MP3 (ID3v2 APIC / PIC), M4A / AAC (MP4 "covr") or FLAC
 * (PICTURE block). Returns an object URL, or null.
 */
export function coverOf(file: ArrayBuffer): string | null {
  const b = new Uint8Array(file)
  try {
    return id3Cover(b) ?? mp4Cover(b) ?? flacCover(b)
  } catch {
    return null // a damaged tag never stops the track from loading
  }
}

const blobUrl = (bytes: Uint8Array, mime: string): string => URL.createObjectURL(new Blob([bytes.slice()], { type: mime }))

/** Sniffs the picture type from its first bytes (tags often say nothing, or the wrong thing). */
function sniff(bytes: Uint8Array, fallback = 'image/jpeg'): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  return fallback
}

function id3Cover(b: Uint8Array): string | null {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null // "ID3"
  const version = b[3]
  const syncsafe = (o: number): number => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]
  const end = Math.min(b.length, 10 + syncsafe(6))
  const idLength = version === 2 ? 3 : 4
  const headerLength = version === 2 ? 6 : 10
  let at = 10
  // Extended header (flag 0x40): skipped. v2.3 gives its size without these 4 bytes, v2.4 with them.
  if (version >= 3 && b[5] & 0x40) {
    at += version === 4 ? syncsafe(10) : (((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) >>> 0) + 4
  }
  while (at + headerLength < end) {
    const id = String.fromCharCode(...b.subarray(at, at + idLength))
    if (!/^[A-Z0-9]+$/.test(id)) break
    const size =
      version === 2
        ? (b[at + 3] << 16) | (b[at + 4] << 8) | b[at + 5]
        : version === 4
          ? syncsafe(at + 4)
          : ((b[at + 4] << 24) | (b[at + 5] << 16) | (b[at + 6] << 8) | b[at + 7]) >>> 0
    const body = at + headerLength
    if (size <= 0 || body + size > end) break
    if (id === 'APIC' || id === 'PIC') {
      const wide = b[body] === 1 || b[body] === 2 // UTF-16 text: terminators are two bytes
      let p = body + 1
      let mime = 'image/jpeg'
      if (version === 2) {
        mime = String.fromCharCode(...b.subarray(p, p + 3)).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg'
        p += 3
      } else {
        const start = p
        while (p < body + size && b[p] !== 0) p++
        const declared = String.fromCharCode(...b.subarray(start, p))
        if (declared.includes('/')) mime = declared
        p++
      }
      p++ // picture type
      // description, terminated by one zero byte (or two, aligned, for wide text)
      if (wide) {
        while (p + 1 < body + size && (b[p] !== 0 || b[p + 1] !== 0)) p += 2
        p += 2
      } else {
        while (p < body + size && b[p] !== 0) p++
        p++
      }
      if (p >= body + size) return null
      const pic = b.subarray(p, body + size)
      return blobUrl(pic, sniff(pic, mime))
    }
    at = body + size
  }
  return null
}

const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

/** M4A / AAC: the "covr" atom (moov › udta › meta › ilst › covr › data). Found by its name, wherever it sits. */
function mp4Cover(b: Uint8Array): string | null {
  if (b.length < 12 || String.fromCharCode(b[4], b[5], b[6], b[7]) !== 'ftyp') return null
  for (let i = 8; i + 24 < b.length; i++) {
    // "covr" then its first "data" child: size(4) "data"(4) type(4) locale(4) picture…
    if (b[i] !== 0x63 || b[i + 1] !== 0x6f || b[i + 2] !== 0x76 || b[i + 3] !== 0x72) continue
    const d = i + 4
    if (String.fromCharCode(b[d + 4], b[d + 5], b[d + 6], b[d + 7]) !== 'data') continue
    const size = u32(b, d)
    if (size < 17 || d + size > b.length) continue
    const kind = u32(b, d + 8) & 0xffffff // 13 = JPEG, 14 = PNG
    const pic = b.subarray(d + 16, d + size)
    return blobUrl(pic, kind === 14 ? 'image/png' : sniff(pic))
  }
  return null
}

/** FLAC: the first PICTURE metadata block (type 6). */
function flacCover(b: Uint8Array): string | null {
  if (b.length < 8 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'fLaC') return null
  let at = 4
  for (;;) {
    if (at + 4 > b.length) return null
    const last = b[at] & 0x80
    const type = b[at] & 0x7f
    const length = (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]
    const body = at + 4
    if (type === 6 && body + length <= b.length) {
      let p = body + 4 // picture type
      const mimeLength = u32(b, p)
      const mime = String.fromCharCode(...b.subarray(p + 4, p + 4 + mimeLength))
      p += 4 + mimeLength
      p += 4 + u32(b, p) // description
      p += 16 // width, height, depth, colours
      const dataLength = u32(b, p)
      const pic = b.subarray(p + 4, p + 4 + dataLength)
      return pic.length ? blobUrl(pic, sniff(pic, mime || 'image/jpeg')) : null
    }
    if (last) return null
    at = body + length
  }
}
