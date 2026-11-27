import { Store } from './store'
import type { Deck } from './engine/deck'
import { parseYouTubeId } from './engine/youtube'
import { parseSpotifyTrack } from './engine/spotify'
import { bpmStore } from './engine/bpm'
import { desktop } from './engine/ytremote'
import { knownVerdict, probeYouTube } from './engine/ytprobe'
import { toast } from './toasts'
import { tagsFromName, tagsOf } from './engine/tags'
import { covers } from './covers'
import { FEATURES } from './ui'
import { mixer } from './engine/mixer'
import { detectBpm } from './engine/analyze'
import { detectKey } from './engine/key'
import { groupRiddims, riddimPrint, type RiddimPrint } from './engine/riddim'
import { fileId, stemsModel, stemsFor } from './engine/ai/stems'
import { MODEL } from './engine/ai/demucs'

export interface Entry {
  id: string
  kind: 'local' | 'youtube' | 'spotify'
  title: string
  artist: string
  file?: File // local only, once opened in this session
  path?: string // local, desktop app: where the file is on disk, so it can be opened again next time
  ref?: string // YouTube video id / Spotify track id
  linked?: string // Spotify: id of the DJ's own file of this track, which goes on the deck instead
  noAutoLink?: boolean // the DJ unlinked it: the music folder leaves it alone
  list?: string // the list (folder) it was filed under, if any
  bpm?: number // local files: measured when added
  key?: string // local files: measured when added
  duration?: number // seconds (links: once played on a deck)
  riddim?: RiddimPrint | null // local files: what its instrumental sounds like (null = measured, no tempo)
  riddimSolo?: boolean // the DJ said it is not part of the riddim it was grouped in
  size?: number // local files: bytes, to tell the same file added twice
  album?: string // local files: from the tags
  albumArtist?: string // local files: the album's own artist, when the tags give one
  tagged?: boolean | number // local files: tags read (TAGS = title, artist, album and cover picture)
  stems?: string // local files, desktop app: the model that separated its AI stems, or 'error'; not loadable before either
}

/** Versions of the same instrumental, found by listening (see engine/riddim.ts). */
export interface Riddim {
  key: string // stable id: the id of its oldest member
  name: string
  members: string[] // entry ids, in library order
}

interface LibraryState {
  entries: Entry[]
  lists: string[]
  error: string | null
  checking: boolean // a pasted link is being checked before it is added
  analyzing: string | null // id of the file being measured now
  onDeck: Record<string, string> // deck name → id of the entry last loaded there
  played: string[] // ids played on a deck (on air) this set, in order
  playedAt: Record<string, number> // id → when it started playing (ms)
  riddims: Riddim[]
  riddimView: string | null // riddim shown in the library (key), null = the normal lists
  separating: string | null // id of the file whose stems are being separated now
  sepProgress: number // 0..1, of that file
  stemsWaiting: string[] // ids of files not checked yet or with no stems (not loadable yet), in order
  stemsUpgrade: string[] // ids of files playing with stems by an older model, to separate again when nothing waits
}

/** Drag type of a library row being dragged onto a deck (the data is the entry id). */
export const ENTRY_DRAG = 'application/x-vx-entry'

/** What reading a file's tags gets now (3: title, artist, album, cover and size); older reads are done again once. */
const TAGS = 3

const LS_PLAYED = 'vx_played'
/** Played marks last through a restart in the same night; after this long without playing, a new set starts clean. */
const SET_GAP = 6 * 3600_000

function loadPlayed(): { played: string[]; playedAt: Record<string, number> } {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_PLAYED) || 'null') as { played: string[]; playedAt: Record<string, number> } | null
    if (!saved?.played?.length) return { played: [], playedAt: {} }
    const last = Math.max(...Object.values(saved.playedAt ?? {}), 0)
    return Date.now() - last < SET_GAP ? { played: saved.played, playedAt: saved.playedAt ?? {} } : { played: [], playedAt: {} }
  } catch {
    return { played: [], playedAt: {} }
  }
}

function savePlayed(played: string[], playedAt: Record<string, number>): void {
  try {
    localStorage.setItem(LS_PLAYED, JSON.stringify({ played, playedAt }))
  } catch {
    /* kept for this run only */
  }
}

const LS_KEY = 'vx_links'
const LS_LISTS = 'vx_lists'
const LS_RIDDIM_NAMES = 'vx_riddim_names'

/** Riddim grouping is set aside for now: no listening in the background, nothing shown. */
export const RIDDIMS_ON = false

/** Names the DJ gave to riddims, by the id of one of their versions. */
function riddimNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_RIDDIM_NAMES) || '{}')
  } catch {
    return {}
  }
}

function loadLists(): string[] {
  try {
    return JSON.parse(localStorage.getItem(LS_LISTS) || '[]')
  } catch {
    return []
  }
}
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aiff?|webm)$/i

function loadLinks(): Entry[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]')
  } catch {
    return []
  }
}

class Library extends Store<LibraryState> {
  constructor() {
    super({
      entries: loadLinks(),
      lists: loadLists(),
      error: null,
      checking: false,
      analyzing: null,
      onDeck: {},
      ...loadPlayed(),
      riddims: [],
      riddimView: null,
      separating: null,
      sepProgress: 0,
      stemsWaiting: [],
      stemsUpgrade: [],
    })
    this.regroup()
    // The same file on disk listed twice (from before duplicates were checked): the first one stays.
    queueMicrotask(() => {
      const seen = new Set<string>()
      for (const e of [...this.state.entries]) {
        if (e.kind !== 'local' || !e.path) continue
        if (seen.has(e.path)) this.dropCopyByPath(e.id)
        else seen.add(e.path)
      }
    })
    // Already known as blocked: out at once; the others are checked a little after start-up.
    queueMicrotask(() => this.dropBlocked(this.state.entries.filter((e) => e.kind === 'youtube' && e.ref && knownVerdict(e.ref) === 'blocked')))
    window.setTimeout(() => void this.sweepYouTube(), 6000)
    window.setTimeout(() => void this.tagOld(), 4000)
    // Every file gets its AI stems in the background as soon as it is in the library, and can be loaded
    // as soon as its own are done. Files with stems by an older model stay loadable while they are
    // separated again, after the new ones; failed ones are tried again.
    const local = this.state.entries.filter((e) => e.kind === 'local' && e.path && e.stems !== MODEL)
    this.separate(local.filter((e) => !e.stems || e.stems === 'error').map((e) => e.id))
    this.upgrade(local.filter((e) => e.stems && e.stems !== 'error').map((e) => e.id))
    // Find the BPM of every saved clip up front, so it is known before the clip reaches a deck.
    for (const e of this.state.entries) this.lookup(e)
    // Files saved without their measurements (added before this existed) are measured in the background.
    // Also files measured before riddims existed, so they find their versions.
    this.measure(
      this.state.entries
        .filter((e) => e.kind === 'local' && (e.duration === undefined || (RIDDIMS_ON && e.duration > 40 && e.riddim === undefined)))
        .map((e) => e.id),
    )
  }

  private queue: string[] = []
  private measuring = false

  /** BPM, key and length of local files, one at a time, without holding up the app. */
  private measure(ids: string[]): void {
    this.queue.push(...ids)
    if (!this.measuring) void this.drain()
  }

  /** The track on this deck started playing: it counts as played (once; the first time is kept). */
  markPlayed(deckName: string): void {
    const id = this.state.onDeck[deckName]
    if (!id || this.state.played.includes(id) || !this.byId(id)) return
    this.set({ played: [...this.state.played, id], playedAt: { ...this.state.playedAt, [id]: Date.now() } })
    savePlayed(this.state.played, this.state.playedAt)
  }

  /** A new set: nothing counts as played any more. */
  clearPlayed(): void {
    this.set({ played: [], playedAt: {} })
    savePlayed([], {})
  }

  /** File name without its extension: what a local entry is called until its tags are read. */
  private static fileTitle(e: Entry): string {
    const name = e.file?.name ?? e.path?.split(/[\\/]/).pop() ?? ''
    return name.replace(/\.[^.]+$/, '')
  }

  /** Title, artist and album from the file's tags, else from an "Artist - Title" name. Never over a name the DJ gave. */
  private applyTags(entry: Entry, bytes: ArrayBuffer): void {
    const current = this.byId(entry.id)
    if (!current) return
    const fromFile = tagsOf(bytes)
    const fromName = tagsFromName(Library.fileTitle(current))
    const untouched = !current.title || current.title === Library.fileTitle(current)
    const title = untouched ? fromFile.title || (fromFile.artist ? undefined : fromName.title) : undefined
    const artist = current.artist ? undefined : fromFile.artist || fromName.artist
    this.patchEntry(entry.id, {
      size: bytes.byteLength,
      tagged: TAGS,
      ...(title ? { title } : {}),
      ...(artist ? { artist } : {}),
      ...(fromFile.album && !current.album ? { album: fromFile.album } : {}),
      ...(fromFile.albumArtist && !current.albumArtist ? { albumArtist: fromFile.albumArtist } : {}),
    })
    if (this.dropCopy(entry.id)) return
    void covers.take(entry.id, bytes)
  }

  /** Files added before tags were read: each one read once, in the background, a little after start-up. */
  private async tagOld(): Promise<void> {
    const todo = this.state.entries.filter((e) => e.kind === 'local' && e.tagged !== TAGS && (e.file || e.path))
    for (const e of todo) {
      if (this.measuring) await new Promise((r) => setTimeout(r, 2000))
      try {
        const bytes = e.file ? await e.file.arrayBuffer() : e.path && desktop ? (await desktop.readAudio(e.path))?.slice().buffer : null
        if (bytes) this.applyTags(e, bytes)
        else this.patchEntry(e.id, { tagged: TAGS })
      } catch {
        this.patchEntry(e.id, { tagged: TAGS })
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  private async drain(): Promise<void> {
    this.measuring = true
    while (this.queue.length) {
      const id = this.queue.shift()!
      const entry = this.byId(id)
      if (!entry || entry.kind !== 'local') continue
      this.set({ analyzing: id })
      try {
        const bytes = entry.file
          ? await entry.file.arrayBuffer()
          : entry.path && desktop
            ? (await desktop.readAudio(entry.path))?.slice().buffer
            : null
        if (bytes) {
          if (entry.tagged !== TAGS) this.applyTags(entry, bytes) // before decoding: that empties the bytes
          const buffer = await mixer.ctx.decodeAudioData(bytes)
          await new Promise((r) => setTimeout(r, 0))
          const bpm = entry.bpm ?? detectBpm(buffer)
          const key = entry.key ?? (await detectKey(buffer))
          const riddim = RIDDIMS_ON ? await riddimPrint(buffer, bpm ?? null) : entry.riddim
          this.patchEntry(id, { duration: buffer.duration, bpm: bpm ?? undefined, key: key ?? undefined, riddim })
          this.regroup()
        }
      } catch {
        this.patchEntry(id, { duration: 0 }) // unreadable: do not try again every start
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    this.set({ analyzing: null })
    this.measuring = false
  }

  // ───────────────────────── AI stems ─────────────────────────

  /** Whether the file is still waiting for its AI stems (desktop app only; links never wait). */
  waitingStems(entry: Entry): boolean {
    return entry.kind === 'local' && this.reachable(entry) && !!desktop?.stemsSave && !entry.stems
  }

  /** The track can be reached: links always; files when open in this session or known on disk. */
  reachable(entry: Entry): boolean {
    return entry.kind !== 'local' || !!entry.file || !!entry.path
  }

  private separate(ids: string[]): void {
    if (!desktop?.stemsSave) return
    const fresh = ids.filter((id) => !this.state.stemsWaiting.includes(id) && id !== this.state.separating)
    if (!fresh.length) return
    this.set({ stemsWaiting: [...this.state.stemsWaiting, ...fresh] })
    if (!this.splitting) void this.splitAll()
  }

  private upgrade(ids: string[]): void {
    if (!desktop?.stemsSave) return
    const fresh = ids.filter((id) => !this.state.stemsUpgrade.includes(id) && id !== this.state.separating)
    if (!fresh.length) return
    this.set({ stemsUpgrade: [...this.state.stemsUpgrade, ...fresh] })
    if (!this.splitting) void this.splitAll()
  }

  private splitting = false
  private checked = new Set<string>() // waiting files already looked at and found without stems

  /**
   * One file at a time (each takes the whole GPU), each freed as soon as it is done. First the files
   * that cannot be loaded yet: a file whose stored stems are by an older model is freed at once (it
   * plays with those) and goes to the upgrade queue, separated again only when nothing else waits.
   */
  private async splitAll(): Promise<void> {
    this.splitting = true
    while (this.state.stemsWaiting.length || this.state.stemsUpgrade.length) {
      const upgrading = !this.state.stemsWaiting.length
      const [id, ...rest] = upgrading ? this.state.stemsUpgrade : this.state.stemsWaiting
      this.set(upgrading ? { stemsUpgrade: rest } : { stemsWaiting: rest })
      const entry = this.byId(id)
      if (!entry || entry.kind !== 'local') continue
      let result = entry.stems && entry.stems !== 'error' ? entry.stems : 'error'
      try {
        const bytes = entry.file
          ? await entry.file.arrayBuffer()
          : entry.path && desktop
            ? (await desktop.readAudio(entry.path))?.slice().buffer
            : null
        if (bytes) {
          const sha = await fileId(bytes)
          const stored = await stemsModel(sha)
          if (stored === MODEL) result = MODEL
          else if (!stored && !upgrading && !this.checked.has(id) && !this.asked.has(id) && rest.length) {
            // Nothing stored: separated after every other waiting file has been looked at (that takes
            // seconds, and frees the ones whose stems are already there).
            this.checked.add(id)
            this.set({ stemsWaiting: [...this.state.stemsWaiting, id] })
            continue
          } else if (stored && !upgrading) {
            // Loadable now with what is there; separated again later.
            result = stored
            this.upgrade([id])
          } else {
            this.set({ separating: id, sepProgress: 0 })
            const done = await stemsFor(
              sha,
              () => mixer.ctx.decodeAudioData(bytes),
              (p) => this.set({ sepProgress: p }),
            )
            if (done) result = MODEL
          }
        }
      } catch (e) {
        console.warn('AI stems failed', entry.title, e)
      }
      this.set({ separating: null, sepProgress: 0 })
      this.checked.delete(id)
      if (!this.byId(id)) continue // removed meanwhile
      this.patchEntry(id, { stems: result })
    }
    this.splitting = false
  }

  /** Separate this one next (the DJ asked for it). */
  private asked = new Set<string>() // the DJ tried to load these: separated first, never put off

  private hurry(id: string): void {
    this.asked.add(id)
    const rest = this.state.stemsWaiting.filter((x) => x !== id)
    if (rest.length !== this.state.stemsWaiting.length) this.set({ stemsWaiting: [id, ...rest] })
  }

  // ───────────────────────── riddims ─────────────────────────

  /** Puts the versions of each instrumental together again (after a file is measured or changed). */
  private regroup(): void {
    if (!RIDDIMS_ON) return
    const prints: Record<string, RiddimPrint> = {}
    for (const e of this.state.entries) if (e.kind === 'local' && e.riddim && !e.riddimSolo) prints[e.id] = e.riddim
    const order = new Map(this.state.entries.map((e, i) => [e.id, i]))
    const names = riddimNames()
    const riddims = groupRiddims(prints).map((members) => {
      members.sort((a, b) => order.get(a)! - order.get(b)!)
      const key = members[0]
      const named = members.map((id) => names[id]).find(Boolean)
      const shortest = members.map((id) => this.byId(id)!.title).sort((a, b) => a.length - b.length)[0]
      return { key, name: named ?? 'Riddim of ' + shortest, members }
    })
    this.set({ riddims })
  }

  /** The riddim a track is in, if any. */
  riddimOf(id: string): Riddim | null {
    return this.state.riddims.find((r) => r.members.includes(id)) ?? null
  }

  /** Shows a riddim's versions in the library (null: back to the normal lists). */
  showRiddim(key: string | null): void {
    this.set({ riddimView: key })
  }

  renameRiddim(key: string, name: string): void {
    const r = this.state.riddims.find((x) => x.key === key)
    if (!r || !name.trim()) return
    const names = riddimNames()
    for (const id of r.members) delete names[id]
    names[r.key] = name.trim()
    try {
      localStorage.setItem(LS_RIDDIM_NAMES, JSON.stringify(names))
    } catch {
      /* not remembered */
    }
    this.regroup()
  }

  /** "Not this riddim": the track leaves its group (and will not be grouped again). */
  leaveRiddim(id: string): void {
    this.patchEntry(id, { riddimSolo: true })
    this.regroup()
  }

  private patchEntry(id: string, change: Partial<Entry>): void {
    this.commit(
      this.state.entries.map((e) => (e.id === id ? { ...e, ...change } : e)),
      this.state.error,
    )
  }

  private commit(entries: Entry[], error: string | null = null): void {
    this.set({ entries, error })
    // Local files are kept only when their place on disk is known (desktop app).
    const links = entries.filter((e) => e.kind !== 'local' || e.path).map(({ file: _file, ...rest }) => rest)
    localStorage.setItem(LS_KEY, JSON.stringify(links))
  }

  /**
   * Adds audio files; one already in the library (same place on disk, or the same file copied
   * elsewhere: same name and size) is not added again, its entry is returned instead.
   */
  addFiles(files: Iterable<File>): Entry[] {
    const added: Entry[] = []
    const result: Entry[] = []
    const skipped: string[] = []
    for (const file of files) {
      if (!file.type.startsWith('audio/') && !AUDIO_EXT.test(file.name)) continue
      const path = desktop?.pathOf(file) ?? undefined
      const known = this.sameFile(path, file.name, file.size, added)
      if (known) {
        // Same file again: it keeps its entry (and gets the file back if it had lost it).
        if (!known.file && this.byId(known.id)) this.patchEntry(known.id, { file, ...(path && !known.path ? { path } : {}) })
        result.push(this.byId(known.id) ?? known)
        skipped.push(known.title)
        continue
      }
      const entry: Entry = { id: crypto.randomUUID(), kind: 'local', title: file.name.replace(/\.[^.]+$/, ''), artist: '', file, path, size: file.size }
      added.push(entry)
      result.push(entry)
    }
    if (added.length) {
      this.commit([...this.state.entries, ...added])
      this.measure(added.map((e) => e.id))
      this.separate(added.map((e) => e.id))
    }
    if (skipped.length) {
      toast.info(
        skipped.length === 1 ? 'Already in the library' : skipped.length + ' already in the library',
        skipped.length === 1 ? '"' + skipped[0] + '" is there once: not added again.' : 'Those files are there once: not added again.',
        { key: 'dup-add' },
      )
    }
    return result
  }

  /** The library's entry for this file, if it is already there: same path, or same file name and size. */
  private sameFile(path: string | undefined, name: string, size: number | undefined, extra: Entry[] = []): Entry | undefined {
    const fileName = name.split(/[\\/]/).pop()!.toLowerCase()
    return [...this.state.entries, ...extra].find(
      (e) =>
        e.kind === 'local' &&
        ((path && e.path === path) ||
          (size !== undefined && e.size === size && (e.file?.name ?? e.path?.split(/[\\/]/).pop() ?? '').toLowerCase() === fileName)),
    )
  }

  /**
   * Copies that got in before this check: once a file's size is known, a later copy of an earlier entry
   * leaves the library (the earlier one keeps its list, played mark and stems), with one message.
   */
  private dropCopy(id: string): boolean {
    const e = this.byId(id)
    if (!e || e.kind !== 'local' || e.size === undefined) return false
    const nameOf = (x: Entry) => (x.file?.name ?? x.path?.split(/[\\/]/).pop() ?? '').toLowerCase()
    const other = this.state.entries.find(
      (x) => x.id !== id && x.kind === 'local' && ((!!x.path && x.path === e.path) || (x.size === e.size && nameOf(x) === nameOf(e))),
    )
    if (!other) return false
    const [keep, drop] = this.state.entries.indexOf(other) < this.state.entries.indexOf(e) ? [other, e] : [e, other]
    if (Object.values(this.state.onDeck).includes(drop.id)) return false // on a deck now: sorted out next time
    if (drop.list && !keep.list) this.patchEntry(keep.id, { list: drop.list })
    this.remove(drop.id)
    this.copies.push(drop.title)
    window.clearTimeout(this.copiesTimer)
    this.copiesTimer = window.setTimeout(() => {
      const n = this.copies.length
      toast.info(n === 1 ? 'Duplicate removed' : n + ' duplicates removed', (n === 1 ? '"' + this.copies[0] + '" was' : 'Those tracks were') + ' in the library twice: one copy is kept.', {
        key: 'dup-clean',
      })
      this.copies = []
    }, 1500)
    return drop.id === id
  }
  private dropCopyByPath(id: string): void {
    const e = this.byId(id)
    const first = e && this.state.entries.find((x) => x.kind === 'local' && x.path === e.path)
    if (!e || !first || first.id === id) return
    if (e.list && !first.list) this.patchEntry(first.id, { list: e.list })
    this.remove(id)
    this.copies.push(e.title)
    window.clearTimeout(this.copiesTimer)
    this.copiesTimer = window.setTimeout(() => {
      const n = this.copies.length
      toast.info(n === 1 ? 'Duplicate removed' : n + ' duplicates removed', 'One copy of each is kept.', { key: 'dup-clean' })
      this.copies = []
    }, 1500)
  }
  private copies: string[] = []
  private copiesTimer = 0

  /** Accepts a YouTube or Spotify track link; returns the (new or existing) entry. */
  addLink(url: string): Entry | null {
    const yt = parseYouTubeId(url)
    const sp = yt ? null : parseSpotifyTrack(url)
    if (sp && !FEATURES.spotify) {
      this.set({ error: "Spotify tracks can't be added for now: paste a YouTube link or drop an audio file." })
      return null
    }
    if (!yt && !sp) {
      this.set({ error: FEATURES.spotify ? 'Link not recognised. Use a YouTube video link or a Spotify track link.' : 'Link not recognised. Use a YouTube video link.' })
      return null
    }
    const kind = yt ? 'youtube' : 'spotify'
    const ref = (yt || sp)!
    const existing = this.state.entries.find((e) => e.kind === kind && e.ref === ref)
    if (existing) {
      this.set({ error: null })
      return existing
    }
    const entry: Entry = {
      id: crypto.randomUUID(),
      kind,
      ref,
      title: (yt ? 'YouTube ' : 'Spotify ') + ref,
      artist: '',
    }
    this.commit([...this.state.entries, entry])
    if (yt) void this.fetchTitle(entry)
    return entry
  }

  // ───────────────────────── the DJ's own file of a Spotify track ─────────────────────────

  /** Title, artist and length of a Spotify track, known before it ever reaches a deck. */
  describe(id: string, title: string, artist: string, duration: number): void {
    const entry = this.byId(id)
    if (!entry || entry.kind !== 'spotify' || !/^Spotify [A-Za-z0-9]{22}$/.test(entry.title)) return
    this.patchEntry(id, { title, artist, duration })
    this.lookup({ ...entry, title, artist })
  }

  /** The file linked to a Spotify entry, if it is still in the library and can be reached. */
  localFor(entry: Entry): Entry | undefined {
    const own = entry.kind === 'spotify' && entry.linked ? this.byId(entry.linked) : undefined
    return own && this.reachable(own) ? own : undefined
  }

  /** A file on disk (a download): added once, measured and split like a dropped file. */
  addPath(path: string): Entry {
    const known = this.state.entries.find((e) => e.kind === 'local' && e.path === path)
    if (known) return known
    const name = path.split(/[\\/]/).pop()!
    const entry: Entry = { id: crypto.randomUUID(), kind: 'local', title: name.replace(/\.[^.]+$/, ''), artist: '', path }
    this.commit([...this.state.entries, entry])
    this.measure([entry.id])
    this.separate([entry.id])
    return entry
  }

  /** Links a file known by its place on disk (the music folder). */
  linkPath(id: string, path: string): void {
    let own = this.state.entries.find((e) => e.kind === 'local' && e.path === path)
    if (!own) {
      const name = path.split(/[\\/]/).pop()!
      own = { id: crypto.randomUUID(), kind: 'local', title: name.replace(/\.[^.]+$/, ''), artist: this.byId(id)?.artist ?? '', path }
      this.commit([...this.state.entries, own])
      this.measure([own.id])
      this.separate([own.id])
    }
    this.patchEntry(id, { linked: own.id, noAutoLink: undefined })
  }

  /** Links a file the DJ picked or dropped. False when it is not an audio file. */
  linkFile(id: string, file: File): boolean {
    const path = desktop?.pathOf(file) ?? undefined
    const own = (path && this.state.entries.find((e) => e.kind === 'local' && e.path === path)) || this.addFiles([file])[0]
    if (!own) return false
    this.patchEntry(id, { linked: own.id, noAutoLink: undefined })
    return true
  }

  /** Back to playing through Spotify; the file stays in the library. */
  unlink(id: string): void {
    this.patchEntry(id, { linked: undefined, noAutoLink: true })
  }

  private lookup(e: Entry): void {
    const named = !/^(YouTube|Spotify) [\w-]+$/.test(e.title)
    if (e.kind === 'youtube' && e.ref && named) bpmStore.lookup('youtube:' + e.ref, e.title, e.artist)
    if (e.kind === 'spotify' && e.ref && named) bpmStore.lookup('spotify:' + e.ref, `${e.artist} - ${e.title}`, e.artist)
  }

  /**
   * Adds a link after checking it can be played here: YouTube's oEmbed answers 401 / 403 when the
   * owner does not allow the video outside youtube.com, and 404 when it is private or gone. Those
   * never enter the library. Offline, the link is added and checked when it loads.
   */
  async addLinkChecked(url: string): Promise<Entry | null> {
    const yt = parseYouTubeId(url)
    if (!yt) return this.addLink(url)
    if (this.state.entries.some((e) => e.kind === 'youtube' && e.ref === yt)) return this.addLink(url)
    this.set({ error: null, checking: true })
    let meta: { title?: string; author_name?: string } | null = null
    try {
      const video = encodeURIComponent('https://www.youtube.com/watch?v=' + yt)
      const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + video)
      if (res.status === 401 || res.status === 403) {
        this.set({ checking: false, error: "Not added: this video's owner doesn't allow it to play outside YouTube." })
        return null
      }
      if (res.status === 404 || res.status === 400) {
        this.set({ checking: false, error: 'Not added: the video is private, removed or the link is wrong.' })
        return null
      }
      if (res.ok) meta = await res.json()
    } catch {
      /* offline: added, checked when it loads */
    }
    // oEmbed does not know every block (labels' music often only plays on youtube.com): try it for real.
    const verdict = await probeYouTube(yt)
    if (verdict === 'blocked') {
      this.set({ checking: false })
      toast.error(
        'Not added to the library',
        (meta?.title ? '"' + meta.title + '": its' : "This video's") + " owner only lets it play on youtube.com, so it can't play in RiddimX.",
        { key: 'yt-blocked' },
      )
      return null
    }
    if (verdict === 'gone') {
      this.set({ checking: false, error: 'Not added: the video is private, removed or the link is wrong.' })
      return null
    }
    this.set({ checking: false })
    const entry = this.addLink(url)
    if (entry && meta?.title) {
      this.rename(entry.id, meta.title, meta.author_name || '')
      this.lookup({ ...entry, title: meta.title, artist: meta.author_name || '' })
    }
    return entry
  }

  /** YouTube's public oEmbed endpoint gives title and channel without loading a player. */
  private async fetchTitle(entry: Entry): Promise<void> {
    try {
      const video = encodeURIComponent('https://www.youtube.com/watch?v=' + entry.ref)
      const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + video)
      if (!res.ok) return
      const json = await res.json()
      if (!json.title) return
      this.rename(entry.id, json.title, json.author_name || '')
      this.lookup({ ...entry, title: json.title, artist: json.author_name || '' })
    } catch {
      /* offline: the title arrives when the clip is loaded on a deck */
    }
  }

  /** Create a list (folder) to file tracks under, e.g. one per event. */
  addList(name: string): void {
    const clean = name.trim()
    if (!clean || this.state.lists.includes(clean)) return
    const lists = [...this.state.lists, clean]
    localStorage.setItem(LS_LISTS, JSON.stringify(lists))
    this.set({ lists })
  }

  /** Delete a list; its tracks stay in the library, unfiled. */
  removeList(name: string): void {
    const lists = this.state.lists.filter((l) => l !== name)
    localStorage.setItem(LS_LISTS, JSON.stringify(lists))
    this.set({ lists })
    this.commit(this.state.entries.map((e) => (e.list === name ? { ...e, list: undefined } : e)))
  }

  /** File a track under a list (or under none). */
  setList(id: string, list: string | undefined): void {
    this.commit(this.state.entries.map((e) => (e.id === id ? { ...e, list } : e)))
  }

  remove(id: string): void {
    this.asked.delete(id)
    covers.forget(id)
    this.set({
      stemsWaiting: this.state.stemsWaiting.filter((x) => x !== id),
      stemsUpgrade: this.state.stemsUpgrade.filter((x) => x !== id),
    })
    queueMicrotask(() => this.regroup()) // a removed version leaves its riddim
    this.commit(this.state.entries.filter((e) => e.id !== id))
  }

  /** YouTube links whose owner only allows youtube.com: out of the library, with one message. */
  dropBlocked(entries: Entry[]): void {
    if (!entries.length) return
    const ids = new Set(entries.map((e) => e.id))
    entries.forEach((e) => this.remove(e.id))
    const named = entries.filter((e) => !/^YouTube [\w-]+$/.test(e.title)).map((e) => '"' + e.title + '"')
    const what = entries.length === 1 ? (named[0] ?? 'A YouTube video') : entries.length + ' YouTube videos' + (named.length ? ' (' + named.slice(0, 3).join(', ') + (named.length > 3 ? '…' : '') + ')' : '')
    toast.error(
      entries.length === 1 ? 'Removed from the library' : entries.length + ' removed from the library',
      what + (entries.length === 1 ? ": its owner only lets it play on youtube.com, so it can't play in RiddimX." : ": their owners only let them play on youtube.com, so they can't play in RiddimX."),
      { key: 'yt-blocked' },
    )
    this.set({ onDeck: Object.fromEntries(Object.entries(this.state.onDeck).filter(([, id]) => !ids.has(id))) })
  }

  /** Links saved before this check existed: each one tried once, quietly, the blocked ones taken out. */
  private async sweepYouTube(): Promise<void> {
    const todo = this.state.entries.filter((e) => e.kind === 'youtube' && e.ref && !knownVerdict(e.ref))
    const blocked: Entry[] = []
    for (const e of todo) {
      if ((await probeYouTube(e.ref!)) === 'blocked') blocked.push(e)
    }
    const still = blocked.filter((e) => this.byId(e.id) && !Object.values(this.state.onDeck).includes(e.id))
    this.dropBlocked(still)
  }

  private rename(id: string, title: string, artist: string): void {
    this.commit(this.state.entries.map((e) => (e.id === id ? { ...e, title, artist } : e)))
  }

  /** Double click: deck A, or deck B while A is playing. Never cuts a deck that is playing. */
  loadFree(entry: Entry, a: Deck, b: Deck): void {
    const target = !a.get().playing ? a : !b.get().playing ? b : null
    if (target) {
      this.set({ error: null })
      this.load(entry, target)
    } else this.set({ error: 'Both decks are playing: drag the track onto a deck or use the A / B buttons' })
  }

  /** Links: their length is only known once a deck has them; keep it for the library. */
  private recordLength(entry: Entry, deck: Deck): void {
    const started = Date.now()
    const stop = deck.subscribe(() => {
      const s = deck.get()
      const mine = s.ref === entry.kind + ':' + entry.ref
      if (mine && s.duration > 0) {
        stop()
        if (Math.abs((entry.duration ?? 0) - s.duration) > 1) this.patchEntry(entry.id, { duration: s.duration })
      } else if (Date.now() - started > 120000) stop()
    })
  }

  /** A file saved in an earlier session: read it from disk again. */
  private async reopen(entry: Entry, deck: Deck): Promise<void> {
    const bytes = entry.path && desktop ? await desktop.readAudio(entry.path) : null
    if (!bytes) {
      this.set({ error: `Couldn't find "${entry.title}". Was it moved or deleted? Add it again.` })
      return
    }
    const name = entry.path!.split('/').pop()!
    const file = new File([bytes.slice()], name, { type: '' })
    this.set({ entries: this.state.entries.map((e) => (e.id === entry.id ? { ...e, file } : e)), error: null })
    void deck.loadFile(file)
  }

  /** Local file still waiting for its BPM, key and length to be measured. */
  waitingAnalysis(entry: Entry): boolean {
    return entry.kind === 'local' && this.reachable(entry) && entry.duration === undefined
  }

  /** Local file the app could not decode: it cannot be played. */
  unreadable(entry: Entry): boolean {
    return entry.kind === 'local' && entry.duration === 0
  }

  /**
   * Can be loaded now: links always; files when open in this session or known on disk, analysed, and
   * (desktop app) with their stems done. Nothing goes onto a deck before that.
   */
  playable(entry: Entry): boolean {
    return this.reachable(entry) && !this.unreadable(entry) && !this.waitingAnalysis(entry) && !this.waitingStems(entry)
  }

  byId(id: string): Entry | undefined {
    return this.state.entries.find((e) => e.id === id)
  }

  load(entry: Entry, deck: Deck): void {
    // A Spotify track the DJ has a file of: the file goes on the deck, with BPM, waveform and stems.
    const own = this.localFor(entry)
    if (own) {
      this.load(own, deck)
      return
    }
    if (entry.kind === 'youtube' && entry.ref && knownVerdict(entry.ref) === 'blocked') {
      this.dropBlocked([entry])
      return
    }
    if (this.unreadable(entry)) {
      const error = `"${entry.title}" can't be played: the file is damaged or not an audio format the app reads.`
      this.set({ error })
      if (deck.get().kind === 'none') deck.notice(error)
      return
    }
    if (this.waitingAnalysis(entry) || this.waitingStems(entry)) {
      // Not ready yet: it goes to the front of the queue and stays in the library; the DJ loads it when it is.
      this.hurry(entry.id)
      const error = `"${entry.title}" is still being analysed and split into stems. It will be ready in the library when done.`
      this.set({ error })
      if (deck.get().kind === 'none') deck.notice(error)
      return
    }
    this.set({ onDeck: { ...this.state.onDeck, [deck.name]: entry.id } })
    if (entry.kind !== 'local') this.recordLength(entry, deck)
    deck.prepare(entry.title) // loading from now on: a PLAY pressed meanwhile waits for this track
    const onMeta = (title: string, artist: string) => this.rename(entry.id, title, artist)
    if (entry.kind === 'local' && !entry.file && entry.path) void this.reopen(entry, deck)
    else if (entry.kind === 'local' && entry.file) void deck.loadFile(entry.file)
    else if (entry.kind === 'youtube' && entry.ref) {
      const named = !/^YouTube [\w-]+$/.test(entry.title)
      void deck.loadYouTube(entry.ref, onMeta, named ? { title: entry.title, artist: entry.artist } : undefined)
    } else if (entry.kind === 'spotify' && entry.ref) void deck.loadSpotify(entry.ref, onMeta)
  }
}

export const library = new Library()
