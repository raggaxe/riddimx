/**
 * A small QR code encoder (byte mode, error correction M, versions 1–10: up to 213 bytes), enough for the
 * phone controller's address. Follows ISO/IEC 18004; structure after Project Nayuki's reference encoder.
 */

// Per version (index 1..10), level M: EC codewords per block, and the data codewords of each block.
const BLOCKS: [number, number[]][] = [
  [0, []],
  [10, [16]],
  [16, [28]],
  [26, [44]],
  [18, [32, 32]],
  [24, [43, 43]],
  [16, [27, 27, 27, 27]],
  [18, [31, 31, 31, 31]],
  [22, [38, 38, 39, 39]],
  [22, [36, 36, 36, 37, 37]],
  [26, [43, 43, 43, 43, 44]],
]
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

function mul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function divisor(degree: number): number[] {
  const out = new Array(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = mul(out[j], root)
      if (j + 1 < degree) out[j] ^= out[j + 1]
    }
    root = mul(root, 2)
  }
  return out
}

function remainder(data: number[], div: number[]): number[] {
  const out = new Array(div.length).fill(0)
  for (const b of data) {
    const factor = b ^ out.shift()!
    out.push(0)
    for (let i = 0; i < div.length; i++) out[i] ^= mul(div[i], factor)
  }
  return out
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0

/** The QR code of `text` as rows of dark (true) / light modules, without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text))
  let version = 1
  for (; version <= 10; version++) {
    const capacity = BLOCKS[version][1].reduce((a, b) => a + b, 0)
    const countBits = version < 10 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= capacity * 8) break
  }
  if (version > 10) throw new Error('text too long for the QR code')
  const [eccLen, blockLens] = BLOCKS[version]
  const capacity = blockLens.reduce((a, b) => a + b, 0)

  // Data bits: byte mode, length, bytes, terminator, padding.
  const bits: number[] = []
  const put = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  put(4, 4)
  put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, capacity * 8 - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity * 8; pad ^= 0xec ^ 0x11) put(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2))

  // Blocks with their error correction, interleaved.
  const div = divisor(eccLen)
  const blocks: number[][] = []
  const eccs: number[][] = []
  let at = 0
  for (const len of blockLens) {
    const block = data.slice(at, at + len)
    at += len
    blocks.push(block)
    eccs.push(remainder(block, div))
  }
  const codewords: number[] = []
  for (let i = 0; i < Math.max(...blockLens); i++) for (const b of blocks) if (i < b.length) codewords.push(b[i])
  for (let i = 0; i < eccLen; i++) for (const e of eccs) codewords.push(e[i])

  const size = version * 4 + 17
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, on: boolean) => {
    dark[y][x] = on
    fixed[y][x] = true
  }

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
      }
  }
  finder(3, 3)
  finder(size - 4, 3)
  finder(3, size - 4)
  const align = ALIGN[version]
  const last = align.length - 1
  for (let i = 0; i <= last; i++)
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }

  const format = (mask: number) => {
    const value = (0 << 3) | mask // level M = 00
    let rem = value
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const b = ((value << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) set(8, i, bit(b, i))
    set(8, 7, bit(b, 6))
    set(8, 8, bit(b, 7))
    set(7, 8, bit(b, 8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i))
    set(8, size - 8, true)
  }
  format(0) // reserves the area; drawn again with the chosen mask

  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const b = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const c = Math.floor(i / 3)
      set(a, c, bit(b, i))
      set(c, a, bit(b, i))
    }
  }

  // Codewords in the zigzag, right to left in column pairs.
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const up = ((right + 1) & 2) === 0
        const y = up ? size - 1 - vert : vert
        if (!fixed[y][x] && i < codewords.length * 8) {
          dark[y][x] = bit(codewords[i >>> 3], 7 - (i & 7))
          i++
        }
      }
  }

  const masks: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ]
  const apply = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && masks[m](x, y)) dark[y][x] = !dark[y][x]
  }
  // Long runs, 2×2 blocks and dark / light balance (the finder-look-alike rule is left out).
  const penalty = () => {
    let p = 0
    for (let a = 0; a < size; a++) {
      let rowRun = 1
      let colRun = 1
      for (let b = 1; b < size; b++) {
        if (dark[a][b] === dark[a][b - 1]) rowRun++
        else rowRun = 1
        if (rowRun === 5) p += 3
        else if (rowRun > 5) p++
        if (dark[b][a] === dark[b - 1][a]) colRun++
        else colRun = 1
        if (colRun === 5) p += 3
        else if (colRun > 5) p++
      }
    }
    let total = 0
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (dark[y][x]) total++
        if (x < size - 1 && y < size - 1) {
          const c = dark[y][x]
          if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) p += 3
        }
      }
    p += Math.floor(Math.abs(total * 20 - size * size * 10) / (size * size)) * 10
    return p
  }
  let best = 0
  let bestScore = Infinity
  for (let m = 0; m < 8; m++) {
    apply(m)
    format(m)
    const score = penalty()
    if (score < bestScore) {
      best = m
      bestScore = score
    }
    apply(m) // undo
  }
  apply(best)
  format(best)
  return dark
}

/** An SVG path of the dark modules, one unit each, with a 4-unit quiet zone (viewBox 0 0 n n). */
export function qrPath(text: string): { d: string; n: number } {
  const m = qrMatrix(text)
  let d = ''
  m.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`
    }),
  )
  return { d, n: m.length + 8 }
}
