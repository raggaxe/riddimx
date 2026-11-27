import { deckA, deckB, type Deck } from './engine/deck'
import { lyrics } from './engine/lyrics'
import { mic } from './engine/mic'
import { mixer } from './engine/mixer'
import { spotify } from './engine/spotify'
import { library } from './library'
import { live } from './live'
import { midi } from './midi'
import type { Store } from './store'
import { toast, toasts } from './toasts'
import { updates } from './updates'
import { confirmBlocked } from './engine/ytprobe'

/** Calls `on` whenever the picked value changes (not on the first read). */
function watch<T, V>(store: Store<T>, pick: (s: T) => V, on: (now: V, before: V) => void): void {
  let before = pick(store.get())
  store.subscribe(() => {
    const now = pick(store.get())
    if (now === before) return
    const was = before
    before = now
    on(now, was)
  })
}

/** An error field shown as a toast while it is set; the toast goes when the error clears. */
function errorToast(key: string, title: string, message: string | null, more = {}): void {
  if (message) toast.error(title, message, { key, ...more })
  else toasts.dismissKey(key)
}

function watchDeck(deck: Deck): void {
  const key = 'deck-' + deck.name
  watch(
    deck,
    (s) => s.error,
    (error) => {
      const s = deck.get()
      // Blocked outside youtube.com: never again, and out of the library (one message says both).
      const id = library.get().onDeck[deck.name]
      const entry = id ? library.byId(id) : undefined
      if (error && s.blocked && entry?.kind === 'youtube' && entry.ref) {
        const ref = entry.ref
        void confirmBlocked(ref).then((sure) => {
          if (!sure || library.get().onDeck[deck.name] !== entry.id) return
          toasts.dismissKey(key)
          library.dropBlocked([entry])
          deck.eject()
        })
      }
      const search = (/^YouTube [\w-]+$/.test(s.title) ? '' : s.title + ' ') + 'audio'
      errorToast(key, 'Deck ' + deck.name, error, {
        actions: s.blocked
          ? [{ label: 'FIND ON YOUTUBE', primary: true, run: () => window.open('https://www.youtube.com/results?search_query=' + encodeURIComponent(search), '_blank') }]
          : undefined,
      })
    },
  )
}

/** Versions the DJ said "not now" to: asked again on the next start, not while this one runs. */
const notNow = new Set<string>()

function watchUpdates(): void {
  const isMac = /Mac/.test(navigator.userAgent)
  const show = (): void => {
    const u = updates.get()
    const v = u.version ?? ''
    if (u.status === 'available' && !u.error && !notNow.has(v)) {
      toasts.show({
        key: 'update',
        kind: 'update',
        sticky: true,
        title: 'RiddimX ' + v + ' is out',
        body: isMac
          ? 'Download it now? It installs the next time you restart RiddimX.'
          : 'Download it now? Its page opens to get the new version.',
        details: u.notes || undefined,
        detailsLabel: "What's new",
        actions: [
          { label: 'DOWNLOAD', primary: true, keep: isMac, run: () => updates.download() },
          { label: 'NOT NOW', run: () => notNow.add(v) },
        ],
      })
    } else if (u.status === 'downloading' && toasts.has('update')) {
      toasts.update('update', {
        title: 'Downloading RiddimX ' + v,
        body: Math.round((u.progress ?? 0) * 100) + '% · you can keep playing',
        progress: u.progress ?? 0,
        actions: [],
      })
    } else if (u.status === 'ready') {
      toasts.show({
        key: 'update',
        kind: 'update',
        sticky: true,
        title: 'RiddimX ' + v + ' is ready',
        body: 'Restart now to update, or it installs by itself when you quit.',
        details: u.notes || undefined,
        detailsLabel: "What's new",
        actions: [
          { label: 'RESTART & UPDATE', primary: true, run: () => updates.install() },
          { label: 'LATER', run: () => undefined },
        ],
      })
    }
  }
  show()
  watch(
    updates,
    (s) => s.status + '|' + (s.version ?? '') + '|' + Math.round((s.progress ?? 0) * 100),
    () => {
      const u = updates.get()
      // A failed download (not a quiet background check that found the network down).
      if (u.status === 'error' && toasts.has('update')) {
        toasts.show({
          key: 'update',
          kind: 'error',
          title: "Couldn't update",
          body: u.error,
          actions: [{ label: 'TRY AGAIN', primary: true, run: () => updates.check() }],
        })
        return
      }
      show()
    },
  )
}

let started = false

/** Starts sending the app's messages to the toasts (once, from the app's root). */
export function startToastWatch(): void {
  if (started) return
  started = true
  watchDeck(deckA)
  watchDeck(deckB)
  watch(mixer, (s) => s.audioError, (e) => errorToast('audio', 'Audio output', e))
  watch(
    mixer,
    (s) => s.missing.join(' and '),
    (names) =>
      names
        ? toast.warn('Audio interface not connected', names + ': playing on the system default for now. It goes back to it by itself when it is plugged in.', { key: 'audio-missing' })
        : toasts.dismissKey('audio-missing'),
  )
  if (mixer.get().missing.length) {
    toast.warn('Audio interface not connected', mixer.get().missing.join(' and ') + ': playing on the system default for now. It goes back to it by itself when it is plugged in.', { key: 'audio-missing' })
  }
  watch(
    mic,
    (s) => s.error,
    (e) =>
      errorToast('mic', 'Microphone', e, {
        actions: e && /Privac/.test(e) ? [{ label: 'OPEN SETTINGS', primary: true, run: () => mic.openSettings() }] : undefined,
      }),
  )
  watch(midi, (s) => s.error, (e) => errorToast('midi', 'MIDI', e))
  watch(spotify, (s) => s.error, (e) => errorToast('spotify', 'Spotify', e))
  watch(library, (s) => s.error, (e) => errorToast('library', 'Library', e))
  watch(lyrics, (s) => s.modelError, (e) => errorToast('ai-model', 'AI install failed', e))
  watch(live, (s) => s.joinError, (e) => errorToast('live-join', 'Join session', e))
  watchUpdates()
}
