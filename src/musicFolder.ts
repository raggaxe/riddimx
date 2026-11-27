import { Store } from './store'
import { library, type Entry } from './library'
import { findFile } from './engine/match'
import { spotify } from './engine/spotify'
import { desktop, type MusicScan } from './engine/ytremote'

const EVERY = 30_000

interface MusicFolderState {
  folder: string | null
  files: string[]
  scanning: boolean
}

/** A Spotify entry still named by its id: its title and artist are not known yet. */
const unnamed = (e: Entry) => /^Spotify [A-Za-z0-9]{22}$/.test(e.title)

class MusicFolder extends Store<MusicFolderState> {
  /** Folder watching needs the desktop app; linking one file by hand works everywhere. */
  readonly available = !!desktop?.musicScan
  private asked = new Set<string>()
  private count = 0

  constructor() {
    super({ folder: null, files: [], scanning: false })
    if (!this.available) return
    queueMicrotask(() => void this.scan())
    window.setInterval(() => void this.scan(), EVERY)
    window.addEventListener('focus', () => void this.scan())
    // A track just added is matched against what the folder already holds.
    library.subscribe(() => {
      const count = library.get().entries.filter((e) => e.kind === 'spotify' && !unnamed(e)).length
      if (count === this.count) return
      this.count = count
      queueMicrotask(() => this.match())
    })
  }

  private async run(ask: () => Promise<MusicScan | null>): Promise<void> {
    this.set({ scanning: true })
    const found = await ask().catch(() => null)
    this.set({ scanning: false, ...(found ?? {}) })
    if (found) {
      this.match()
      void this.nameTracks()
    }
  }

  async scan(): Promise<void> {
    if (desktop?.musicScan && !this.state.scanning) await this.run(() => desktop!.musicScan!())
  }

  async pick(): Promise<void> {
    if (desktop?.musicPick) await this.run(() => desktop!.musicPick!())
  }

  async forget(): Promise<void> {
    if (desktop?.musicForget) await this.run(() => desktop!.musicForget!())
  }

  /** Links every Spotify track that has no file yet to the one in the folder that is clearly it. */
  match(): void {
    if (!this.state.files.length) return
    for (const e of library.get().entries) {
      if (e.kind !== 'spotify' || e.noAutoLink || unnamed(e) || library.localFor(e)) continue
      const path = findFile(e, this.state.files)
      if (path) library.linkPath(e.id, path)
    }
  }

  /** Tracks saved without a title (never played) get it from Spotify, so they can be matched. */
  private async nameTracks(): Promise<void> {
    if (!this.state.folder || !spotify.get().loggedIn) return
    for (const e of library.get().entries.filter((x) => x.kind === 'spotify' && x.ref && unnamed(x))) {
      if (this.asked.has(e.id)) continue
      this.asked.add(e.id)
      try {
        const t = await spotify.api('GET', '/tracks/' + e.ref)
        const artist = (t.artists ?? []).map((a: { name: string }) => a.name).join(', ')
        library.describe(e.id, t.name, artist, t.duration_ms / 1000)
      } catch {
        /* offline or refused: tried again next start */
      }
    }
  }
}

export const musicFolder = new MusicFolder()
