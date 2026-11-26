import { fileId, stemsFor } from './ai/stems'
import type { AiPart } from './deck'
import { mixer } from './mixer'
import { desktop } from './ytremote'
import type { Entry } from '../library'

/**
 * A track opened only to cut a drop from it (not on a deck): from the library or a file on the
 * computer. Its four AI stems come from the store when the track was split before (the library does
 * that in the background), or are split on request.
 */
export interface ClipTrack {
  title: string
  buffer: AudioBuffer
  id: string | null // the file's fingerprint, the key of its stems in the store
  stems: Record<AiPart, AudioBuffer> | null
}

const PARTS: AiPart[] = ['vocals', 'drums', 'bass', 'other']

async function decodeStems(files: Record<AiPart, Uint8Array>): Promise<Record<AiPart, AudioBuffer>> {
  const parts = await Promise.all(PARTS.map((p) => mixer.ctx.decodeAudioData(files[p].slice().buffer)))
  return Object.fromEntries(PARTS.map((p, i) => [p, parts[i]])) as Record<AiPart, AudioBuffer>
}

/** Splitting stems happens in the desktop app only (the model runs there and the stems are stored). */
export const canSplit = (): boolean => !!desktop?.stemsSave

export async function openClipFile(file: File, title = file.name.replace(/\.[^.]+$/, '')): Promise<ClipTrack> {
  const bytes = await file.arrayBuffer()
  const buffer = await mixer.ctx.decodeAudioData(bytes.slice(0))
  let id: string | null = null
  let stems: Record<AiPart, AudioBuffer> | null = null
  try {
    id = await fileId(bytes)
    const files = desktop?.stemsCached ? await desktop.stemsCached(id) : null
    if (files) stems = await decodeStems(files as unknown as Record<AiPart, Uint8Array>)
  } catch {
    /* no stems yet: they can be split on request */
  }
  return { title, buffer, id, stems }
}

/** A library entry's audio (a local file; read from disk again when this session has not opened it). */
export async function openClipEntry(entry: Entry): Promise<ClipTrack | null> {
  if (entry.kind !== 'local') return null
  let file = entry.file
  if (!file && entry.path && desktop) {
    const bytes = await desktop.readAudio(entry.path)
    if (bytes) file = new File([bytes.slice()], entry.path.split('/').pop()!, { type: '' })
  }
  if (!file) return null
  return openClipFile(file, (entry.artist ? entry.artist + ' – ' : '') + entry.title)
}

/** Splits the track into its four stems (about half a minute) and keeps them for next time. */
export async function splitClipStems(t: ClipTrack, onProgress: (p: number) => void): Promise<Record<AiPart, AudioBuffer> | null> {
  if (!t.id || !canSplit()) return null
  const files = await stemsFor(t.id, async () => t.buffer, onProgress)
  return files ? decodeStems(files as unknown as Record<AiPart, Uint8Array>) : null
}
