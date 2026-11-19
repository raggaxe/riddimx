import { Store } from './store'
import type { Deck } from './engine/deck'
import { parseYouTubeId } from './engine/youtube'
import { parseSpotifyTrack } from './engine/spotify'
import { bpmStore } from './engine/bpm'
import { desktop } from './engine/ytremote'
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
  list?: string // the list (folder) it was filed under, if any
  bpm?: number // local files: measured when added
  key?: string // local files: measured when added
  duration?: number // seconds (links: once played on a deck)
  riddim?: RiddimPrint | null // local files: what its instrumental sounds like (null = measured, no tempo)
  riddimSolo?: boolean // the DJ said it is not part of the riddim it was grouped in
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
  played: string[] // ids loaded on a deck during this session
  riddims: Riddim[]
  riddimView: string | null // riddim shown in the library (key), null = the normal lists
  separating: string | null // id of the file whose stems are being separated now
  sepProgress: number // 0..1, of that file
  stemsWaiting: string[] // ids of files not checked yet or with no stems (not loadable yet), in order
  stemsUpgrade: string[] // ids of files playing with stems by an older model, to separate again when nothing waits
}

/** Drag type of a library row being dragged onto a deck (the data is the entry id). */
export const ENTRY_DRAG = 'application/x-vx-entry'

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
      played: [],
      riddims: [],
      riddimView: null,
      separating: null,
      sepProgress: 0,
      stemsWaiting: [],
      stemsUpgrade: [],
    })
    this.regroup()
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

  addFiles(files: Iterable<File>): Entry[] {
    const added: Entry[] = []
    for (const file of files) {
      if (!file.type.startsWith('audio/') && !AUDIO_EXT.test(file.name)) continue
      added.push({
        id: crypto.randomUUID(),
        kind: 'local',
        title: file.name.replace(/\.[^.]+$/, ''),
        artist: '',
        file,
        path: desktop?.pathOf(file) ?? undefined,
      })
    }
    if (added.length) {
      this.commit([...this.state.entries, ...added])
      this.measure(added.map((e) => e.id))
      this.separate(added.map((e) => e.id))
    }
    return added
  }

  /** Accepts a YouTube or Spotify track link; returns the (new or existing) entry. */
  addLink(url: string): Entry | null {
    const yt = parseYouTubeId(url)
    const sp = yt ? null : parseSpotifyTrack(url)
    if (!yt && !sp) {
      this.set({ error: 'Link not recognised. Use a YouTube video link or a Spotify track link.' })
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
    this.set({
      stemsWaiting: this.state.stemsWaiting.filter((x) => x !== id),
      stemsUpgrade: this.state.stemsUpgrade.filter((x) => x !== id),
    })
    queueMicrotask(() => this.regroup()) // a removed version leaves its riddim
    this.commit(this.state.entries.filter((e) => e.id !== id))
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
    this.set({
      onDeck: { ...this.state.onDeck, [deck.name]: entry.id },
      played: this.state.played.includes(entry.id) ? this.state.played : [...this.state.played, entry.id],
    })
    if (entry.kind !== 'local') this.recordLength(entry, deck)
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
