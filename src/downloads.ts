import { Store } from './store'
import { library } from './library'
import { desktop, type DownloadState } from './engine/ytremote'
import { toast } from './toasts'

export interface Download extends DownloadState {
  entryId?: string // its library entry, once done
  at: number
}

interface DownloadsState {
  list: Download[] // newest first
  folder: string | null
}

/** Audio files from direct links, downloaded by the desktop app and put in the library when done. */
class Downloads extends Store<DownloadsState> {
  readonly available = !!desktop?.dlStart

  constructor() {
    super({ list: [], folder: null })
    if (!this.available) return
    desktop!.onDownload!((d) => this.onState(d))
    void desktop!.dlFolder?.().then((folder) => this.set({ folder }))
  }

  /** Starts a download; false when the link was refused before it began. */
  async start(url: string): Promise<boolean> {
    const link = url.trim()
    if (!link || !desktop?.dlStart) return false
    if (this.state.list.some((d) => d.url === link && d.status === 'downloading')) return false
    const id = await desktop.dlStart(link)
    if (id === null) return false
    // Its first news may already be here (a link refused at once): that one stays.
    if (!this.state.list.some((d) => d.id === id)) {
      this.set({ list: [{ id, url: link, status: 'downloading', at: Date.now() }, ...this.state.list] })
    }
    return true
  }

  cancel(id: number): void {
    void desktop?.dlCancel?.(id)
  }

  /** Takes finished, failed and cancelled ones off the list (the files stay). */
  clear(): void {
    this.set({ list: this.state.list.filter((d) => d.status === 'downloading') })
  }

  remove(id: number): void {
    this.set({ list: this.state.list.filter((d) => d.id !== id) })
  }

  reveal(path?: string): void {
    void desktop?.dlReveal?.(path ?? '')
  }

  private onState(d: DownloadState): void {
    const old = this.state.list.find((x) => x.id === d.id)
    const item: Download = { ...old, ...d, at: old?.at ?? Date.now() }
    if (d.status === 'done' && d.path && !old?.entryId) {
      item.entryId = library.addPath(d.path).id
      toast.info('Downloaded', (d.name ?? 'The file') + ' is in the library.', { key: 'dl-' + d.id })
    }
    if (d.status === 'error' && old?.status !== 'error') {
      toast.error("Couldn't download", d.error, { key: 'dl-' + d.id })
    }
    this.set({ list: old ? this.state.list.map((x) => (x.id === d.id ? item : x)) : [item, ...this.state.list] })
  }
}

export const downloads = new Downloads()
