/**
 * Cover picture embedded in an MP3 (ID3v2 "APIC" / "PIC" frame). Returns an object URL, or null.
 * Other containers (FLAC, M4A) are not read.
 */
export function coverOf(file: ArrayBuffer): string | null {
  const b = new Uint8Array(file)
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null // "ID3"
  const version = b[3]
  const syncsafe = (o: number): number => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]
  const end = Math.min(b.length, 10 + syncsafe(6))
  const idLength = version === 2 ? 3 : 4
  const headerLength = version === 2 ? 6 : 10
  let at = 10
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
      return URL.createObjectURL(new Blob([b.slice(p, body + size)], { type: mime }))
    }
    at = body + size
  }
  return null
}
