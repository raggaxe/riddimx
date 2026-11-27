import { Store } from './store'
import { coverOf } from './engine/cover'
import type { Entry } from './library'

/**
 * Small cover pictures for the library's Artists and Albums views: taken once from each file's own
 * embedded picture, shrunk to a thumbnail and kept in IndexedDB (they never go into localStorage).
 * YouTube links use the clip's thumbnail.
 */
const DB = 'vx-covers'
const STORE = 'thumbs'
const SIZE = 192

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

class Covers extends Store<{ thumbs: Record<string, string> }> {
  private db: Promise<IDBDatabase> | null = null

  constructor() {
    super({ thumbs: {} })
    void this.loadAll()
  }

  private conn(): Promise<IDBDatabase> {
    this.db ??= open()
    return this.db
  }

  private async loadAll(): Promise<void> {
    try {
      const db = await this.conn()
      const thumbs: Record<string, string> = {}
      await new Promise<void>((resolve) => {
        const cursor = db.transaction(STORE).objectStore(STORE).openCursor()
        cursor.onsuccess = () => {
          const c = cursor.result
          if (!c) return resolve()
          thumbs[String(c.key)] = String(c.value)
          c.continue()
        }
        cursor.onerror = () => resolve()
      })
      this.set({ thumbs: { ...thumbs, ...this.state.thumbs } })
    } catch {
      /* no covers this time */
    }
  }

  /** The picture to show for a track, if there is one. */
  of(e: Entry): string | null {
    if (e.kind === 'youtube' && e.ref) return 'https://i.ytimg.com/vi/' + encodeURIComponent(e.ref) + '/mqdefault.jpg'
    return this.state.thumbs[e.id] ?? null
  }

  /** Takes the picture embedded in a file (bytes read anyway for its tags) and keeps a thumbnail. */
  async take(id: string, bytes: ArrayBuffer): Promise<void> {
    if (this.state.thumbs[id]) return
    const url = coverOf(bytes)
    if (!url) return
    try {
      const img = await createImageBitmap(await (await fetch(url)).blob())
      const scale = Math.min(1, SIZE / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      img.close()
      const thumb = canvas.toDataURL('image/jpeg', 0.82)
      this.set({ thumbs: { ...this.state.thumbs, [id]: thumb } })
      const db = await this.conn()
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(thumb, id)
    } catch {
      /* an odd picture: no cover */
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  forget(id: string): void {
    if (!this.state.thumbs[id]) return
    const thumbs = { ...this.state.thumbs }
    delete thumbs[id]
    this.set({ thumbs })
    void this.conn().then((db) => db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)).catch(() => undefined)
  }
}

export const covers = new Covers()
