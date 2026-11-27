/**
 * Which of the DJ's own audio files is the same recording as a Spotify track, judged by name:
 * "Artist - Title.mp3", or Artist/Album/03 Title.m4a. Strict on purpose: a missed file can be linked
 * by hand, a wrong one would only be noticed on air.
 */

/** Words that make it a different recording: the file and the track must agree on them. */
const VERSIONS = ['remix', 'rmx', 'mix', 'acoustic', 'live', 'instrumental', 'dub', 'edit', 'karaoke', 'acapella', 'demo', 'slowed', 'sped']
/** Words a file name may carry without being about the music. */
const NOISE = new Set(['official', 'audio', 'video', 'lyrics', 'hq', 'hd', 'kbps', '320', '256', '192', '128', 'feat', 'ft', 'featuring', 'prod', 'and', 'x', 'remaster', 'remastered'])

function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bao vivo\b/g, 'live')
    .replace(/\bacustico\b/g, 'acoustic')
    .replace(/\b(original|album|radio) (mix|version|edit)\b/g, ' ')
    .replace(/\bremaster(ed)?( \d{4})?\b|\b\d{4} remaster(ed)?\b/g, ' ')
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

export interface Wanted {
  title: string
  artist: string // "A, B"
}

/** The best file for the track, or null when none is clearly it. `files` are full paths or file names. */
export function findFile(track: Wanted, files: string[]): string | null {
  // "(feat. X)" and "- with X" name guests, not the song.
  const title = words(track.title.replace(/[([](feat\.?|ft\.?|with|com|part\.?) [^)\]]*[)\]]/gi, ' '))
  const artists = track.artist.split(',').map(words).filter((a) => a.length)
  if (!title.length || !artists.length) return null
  const guests = new Set(words(track.title + ' ' + track.artist))
  let best: { file: string; extra: number } | null = null
  for (const file of files) {
    const parts = file.split(/[\\/]/)
    const name = parts.pop()!.replace(/\.[^.]+$/, '').replace(/^\s*\d{1,3}\s*[-._)]*\s+/, '')
    const inName = words(name)
    const around = new Set([...words(parts.slice(-2).join(' ')), ...inName])
    if (!title.every((w) => inName.includes(w))) continue
    if (!artists[0].every((w) => around.has(w))) continue
    if (VERSIONS.some((v) => title.includes(v) !== inName.includes(v))) continue
    const extra = inName.filter((w) => !guests.has(w) && !NOISE.has(w) && !/^\d{2,3}kbps$/.test(w)).length
    if (extra === 0 && (!best || inName.length < words(best.file.split(/[\\/]/).pop()!).length)) best = { file, extra }
  }
  return best?.file ?? null
}
