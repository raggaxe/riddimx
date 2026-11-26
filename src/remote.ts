import { Store } from './store'
import { desktop, type RemoteInfo } from './engine/ytremote'
import { decks } from './engine/deck'
import { mixer } from './engine/mixer'
import { dubBox } from './engine/dubbox'
import { sampler } from './engine/sampler'
import { STEMS } from './engine/stems'
import { padModes } from './padmode'
import { midi, runAction } from './midi'
import { settings } from './settings'
import { MOVES, type Move } from './engine/moves'
import { panelLayout, panelValues, setPanel } from './remotePanels'
import { library } from './library'
import { bpmStore } from './engine/bpm'
import { keyStore } from './engine/key'
import { phoneHangUp, phoneOffer } from './phoneMic'

/**
 * The phone as a controller (desktop app). The phone's page (electron/remote.html) sends the ids of the same
 * actions a MIDI controller uses, and gets the decks' state back a few times a second to light its pads.
 */
export interface RemoteState extends RemoteInfo {
  available: boolean // only the desktop app can serve the phone
  busy: boolean
}

const LS = 'vx_remote_on'

class Remote extends Store<RemoteState> {
  private timer = 0
  private lastSent = ''
  /** Stops listening (a code reload makes a new one). */
  dispose: () => void = () => undefined

  constructor() {
    super({ available: !!desktop?.remoteStart, busy: false, on: false, port: 0, clients: 0, urls: [] })
    if (!desktop?.remoteStart) return
    const off1 = desktop.onRemote?.((msg, client) => this.message(msg, client))
    const off2 = desktop.onRemoteClients?.((clients) => {
      if (!clients) phoneHangUp() // the last phone left: its microphone with it
      this.set({ clients })
      this.lastSent = '' // a new phone gets everything at once
      this.pump()
    })
    this.dispose = () => {
      off1?.()
      off2?.()
      clearInterval(this.timer)
    }
    let wanted = false
    try {
      wanted = localStorage.getItem(LS) === '1'
    } catch {
      /* off */
    }
    if (wanted) void this.turn(true)
    else void desktop.remoteInfo?.().then((info) => info && this.set(info))
  }

  async turn(on: boolean): Promise<void> {
    if (!desktop?.remoteStart || this.state.busy) return
    this.set({ busy: true })
    const info = on ? await desktop.remoteStart() : await desktop.remoteStop!()
    this.set({ ...info, busy: false, error: info.error })
    try {
      localStorage.setItem(LS, info.on ? '1' : '0')
    } catch {
      /* not remembered */
    }
    this.pump()
  }

  /** New pairing code: the phones in use now need to scan the new QR code. */
  async renew(): Promise<void> {
    if (!desktop?.remoteRenew) return
    this.set({ busy: true })
    const info = await desktop.remoteRenew()
    this.set({ ...info, busy: false })
  }

  private message(msg: Record<string, unknown>, client: number): void {
    // The phone's microphone: its call comes in over this socket, the answer goes back the same way.
    if (msg.t === 'rtc' && typeof msg.sdp === 'string' && msg.sdp.length < 30000) {
      void phoneOffer(msg.sdp, client).then((sdp) => desktop?.remoteReply?.(client, JSON.stringify(sdp ? { t: 'rtc', sdp } : { t: 'rtc-fail' })))
      return
    }
    if (msg.t === 'rtc-stop') return phoneHangUp(client)
    controlMessage(msg, (text) => desktop?.remoteReply?.(client, text), 'Phone')
  }

  /** The decks' state to the phones: about 12 times a second while one is connected, only when it changed. */
  private pump(): void {
    clearInterval(this.timer)
    if (!this.state.on || !this.state.clients) return
    this.timer = window.setInterval(() => {
      const text = JSON.stringify(snapshot())
      if (text === this.lastSent) return
      this.lastSent = text
      desktop?.remoteState?.(text)
    }, 80)
  }
}

/**
 * One message from a controller (the phone's page, or a guest co-DJ's app): the same action ids a MIDI
 * controller uses, the platter, the library. `only` keeps a guest to its own deck: anything for the
 * other deck, the mixer or the panels is ignored. `reply` answers that controller alone.
 */
export function controlMessage(msg: Record<string, unknown>, reply: (text: string) => void, who: string, only?: 'A' | 'B'): void {
  const t = msg.t
  if (t === 'hello') {
    // The first message also carries what never changes while the page is open: the transitions.
    const moves = (Object.keys(MOVES) as Move[]).map((m) => ({ id: 'moves.' + m, label: MOVES[m].label }))
    reply(JSON.stringify({ ...snapshot(), moves, panels: panelLayout() }))
    return
  }
  // The platter on the phone: hand on the record, and how far it turned (degrees, like the screen's platter).
  const deck = only && msg.d !== only ? null : msg.d === 'A' ? decks[0] : msg.d === 'B' ? decks[1] : null
  if (t === 'touch' && deck) return deck.jogTouch(!!msg.on)
  if (t === 'turn' && deck && typeof msg.deg === 'number' && Number.isFinite(msg.deg)) {
    const deg = Math.max(-720, Math.min(720, msg.deg))
    return deck.get().playing && !msg.held ? deck.jog(deg / 6) : deck.scratch(deg / 6)
  }
  // The library, browsed from the phone: a search gives the tracks back, a tap loads one on a deck.
  if (t === 'lib') {
    reply(JSON.stringify({ t: 'lib', items: libraryItems(typeof msg.q === 'string' ? msg.q : '') }))
    return
  }
  if (t === 'load' && deck && typeof msg.id === 'string') {
    const entry = library.byId(msg.id)
    if (!entry) return
    if (deck.get().playing) {
      reply(JSON.stringify({ t: 'load', ok: false, error: 'Deck ' + deck.name + ' is playing: stop it first.' }))
      return
    }
    library.load(entry, deck)
    const ok = library.playable(entry)
    reply(JSON.stringify({ t: 'load', ok, error: ok ? '' : library.get().error ?? 'Not ready yet.' }))
    if (ok) midi.say(who + ' · ' + entry.title + ' → deck ' + deck.name)
    return
  }
  if (t === 'p' && typeof msg.k === 'string' && !only) {
    setPanel(msg.k, msg.v)
    return
  }
  if (t === 'a' && typeof msg.id === 'string' && (!only || msg.id.startsWith('deck' + only + '.'))) {
    const action = runAction(msg.id, Number(msg.v))
    if (action && (action.type === 'button' || (action.type === 'hold' && Number(msg.v) > 0)))
      midi.say(who + ' · ' + action.label)
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** The library for the phone: newest first, filtered by every word of the search, 300 at most. */
function libraryItems(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const { entries, onDeck } = library.get()
  const bpms = bpmStore.get().bpms
  return [...entries]
    .reverse()
    .filter((e) => words.every((w) => (e.title + ' ' + e.artist).toLowerCase().includes(w)))
    .slice(0, 300)
    .map((e) => {
      const ref = e.kind === 'local' ? null : e.kind + ':' + e.ref
      const bpm = e.kind === 'local' ? (e.bpm ?? null) : ref ? (bpms[ref] ?? null) : null
      return {
        id: e.id,
        title: e.title,
        artist: e.artist,
        bpm: bpm ? Math.round(bpm * 10) / 10 : null,
        key: e.kind === 'local' ? (e.key ?? null) : ref ? keyStore.get(ref) : null,
        dur: e.duration ? Math.round(e.duration) : null,
        kind: e.kind,
        ready: library.playable(e),
        on: (['A', 'B'] as const).filter((n) => onDeck[n] === e.id),
      }
    })
}

/** The deck's pitch range on screen (±8, 16 or 50 %), as the pitch action uses it. */
function pitchRange(name: string): number {
  try {
    const r = Number(localStorage.getItem('vx_pitch_range_' + name))
    return [8, 16, 50].includes(r) ? r : 8
  } catch {
    return 8
  }
}

/** The decks' state, as the phone's page and a guest's app draw it. */
export function snapshot() {
  const modes = padModes.get()
  const deck = (i: 0 | 1) => {
    const d = decks[i]
    const s = d.get()
    return {
      kind: s.kind,
      title: s.title,
      artist: s.artist,
      playing: s.playing,
      loading: s.loading,
      queued: d.playQueued,
      bpm: s.bpm ? Math.round(s.bpm * s.rate * 10) / 10 : null,
      rate: r2((s.rate - 1) * 100),
      pitch: r2(Math.max(-1, Math.min(1, ((s.rate - 1) * 100) / pitchRange(d.name)))), // the fader, in the deck's range
      key: s.key,
      pos: Math.round(d.getPosition() * 10) / 10,
      dur: Math.round(s.duration),
      volume: r2(s.volume),
      high: r2(s.high),
      mid: r2(s.mid),
      low: r2(s.low),
      filter: r2(s.filter),
      gain: r2(s.gain),
      fxAmount: r2(s.fxAmount),
      fxOn: s.fxOn,
      fx: s.fx,
      sync: s.syncOn,
      pfl: s.pfl,
      dub: s.dubbing,
      keyLock: s.keyLock,
      mode: modes[d.name as 'A' | 'B'],
      hot: s.hotcues.map((h) => h !== null),
      loop: s.loop?.beats ?? 0,
      stems: STEMS.map((st) => s.stems[st]),
    }
  }
  const m = mixer.get()
  const x = dubBox.get()
  return {
    t: 's',
    colors: { A: settings.get().colorA, B: settings.get().colorB },
    A: deck(0),
    B: deck(1),
    mixer: { crossfader: r2(m.crossfader), master: r2(m.master), rec: m.recording, fading: m.fading },
    dub: {
      preset: x.preset ?? x.patch.sampleName ?? '',
      playing: x.playing,
      throwing: x.throwing,
      level: r2(x.level),
      slots: x.slots.map((sl) => sl?.name ?? null),
      slot: x.slotPlaying,
    },
    sampler: sampler.get().pads.map((p) => ({ name: p.name, on: p.playing })),
    panel: panelValues(),
  }
}

export const remote = new Remote()

// Editing this file while the app runs: the old one lets go, so the phone's messages are not run twice.
import.meta.hot?.dispose(() => remote.dispose())
