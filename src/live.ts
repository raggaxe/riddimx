import { Store } from './store'
import { desktop } from './engine/ytremote'
import { decks } from './engine/deck'
import { mixer } from './engine/mixer'
import { midi } from './midi'
import { controlMessage, snapshot } from './remote'
import { MUSIC_PUBLISH, endRelaySet, keepRelaySet, openRelaySet, relayConfig, relayGuestToken, rememberSet, rememberedSet, type RelayConfig, type RelaySet } from './relay'
import type { Room } from 'livekit-client'

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * GO LIVE and guest co-DJ, over WebRTC.
 *
 * Host: the finished master (mixer.masterOut, after the compressor and limiter) goes to each listener
 * as its own WebRTC call, Opus stereo. The app's server (electron/live.cjs) only passes the calls'
 * set-up messages, and ngrok gives it a public address. Each call goes straight from this Mac to
 * the listener: no media server, ~130 kbps of upload per listener, under a second of delay.
 *
 * Guest: another RiddimX joins with the invite link. It gets the same master as a call, plus a data
 * channel that carries the phone controller's messages (remote.ts controlMessage), kept to the
 * deck the host gives it. The host's engine plays everything; the guest only steers.
 *
 * YouTube and Spotify decks are never broadcast (their terms forbid restreaming): while one of them
 * is audible in the master, the listeners get silence and a note, and the DJ sees why.
 */

const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]
const BITRATE = 160000
/** The rate every listener drops to while the upload is struggling. */
const LOW_BITRATE = 96000

export interface LiveLinks {
  listen: string
  guest: string
}
export interface LiveInfo {
  on: boolean
  port: number
  public: LiveLinks
  lan: LiveLinks
  lanIp: LiveLinks
  local: LiveLinks
  reach: 'off' | 'checking' | 'open' | 'double' | 'cgnat' | 'unknown' | 'closed'
  nat: string
  method: string // 'UPnP' | 'NAT-PMP' | ''
  router: string
  localIp: string
  reachError: string
  listeners: number
  guests: number
  error?: string
}
export interface LiveSignal {
  t: 'join' | 'leave' | 'msg'
  id: number
  role: 'listen' | 'guest'
  msg?: Record<string, unknown>
}

type Snap = ReturnType<typeof snapshot>
export interface LibItem {
  id: string
  title: string
  artist: string
  bpm: number | null
  dur: number | null
  ready: boolean
  on: ('A' | 'B')[]
}

export interface LiveState {
  available: boolean // the desktop app serves the link
  busy: boolean
  on: boolean
  info: LiveInfo | null
  listeners: number // calls connected now
  held: string | null // why the broadcast is silent now (a YouTube / Spotify deck), or null
  congested: boolean // the upload is full: lower rate for everyone, newcomers turned away
  turnedAway: number // listeners refused because of it, this set
  guest: { id: number; connected: boolean } | null
  guestDeck: 'A' | 'B'
  error: string | null
  /** 'direct': from this Mac (home network reachable); 'relay': through the DJ's own server. */
  via: 'direct' | 'relay'
  relay: { listen: string; guest: string } | null
  relayState: 'off' | 'connecting' | 'on' | 'error' | 'none' // 'none': no server set up
  relayError: string
  // ── this app as a guest in someone else's set ──
  joined: 'off' | 'connecting' | 'on' | 'error'
  joinError: string | null
  hostDeck: 'A' | 'B' // the deck the host gave us
  snap: Snap | null
  lib: LibItem[]
  libMsg: string
}

/** All the network candidates are in, or `ms` has passed. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const t = window.setTimeout(resolve, ms)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        window.clearTimeout(t)
        resolve()
      }
    })
  })
}

/** Ask the far end's Opus for stereo at a music bit rate (WebRTC defaults to mono, voice-sized). */
function musicOpus(sdp: string): string {
  const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1]
  if (!pt) return sdp
  const line = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)')
  const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=' + BITRATE + ';useinbandfec=1'
  if (line.test(sdp)) {
    return sdp.replace(line, (_m, params: string) => {
      const kept = params
        .split(';')
        .filter((p) => p && !/^(stereo|sprop-stereo|maxaveragebitrate|useinbandfec)=/.test(p.trim()))
      return 'a=fmtp:' + pt + ' ' + [...kept, extra].join(';')
    })
  }
  return sdp.replace(new RegExp('(a=rtpmap:' + pt + ' opus/48000[^\\r\\n]*\\r?\\n)', 'i'), '$1a=fmtp:' + pt + ' ' + extra + '\r\n')
}

const reply = (id: number, o: object) => desktop?.liveSend?.(id, JSON.stringify(o))

class Live extends Store<LiveState> {
  private tap: MediaStreamAudioDestinationNode | null = null
  private gate: GainNode | null = null
  private calls = new Map<number, { pc: RTCPeerConnection; role: 'listen' | 'guest'; dc?: RTCDataChannel }>()
  private timer = 0
  private lastNow = ''
  private lastSnap = ''
  // guest side
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private out: HTMLAudioElement | null = null
  // the relay (both sides)
  private room: Room | null = null
  private relaySet: { cfg: RelayConfig; set: RelaySet } | null = null
  private guestRoom: Room | null = null
  private heartbeat = 0
  /** The guest's messages to the host, one after the other (order matters for faders; the first waits for the channel). */
  private sendChain: Promise<void> = Promise.resolve()
  dispose: () => void = () => undefined

  constructor() {
    super({
      available: !!desktop?.liveStart,
      busy: false,
      on: false,
      info: null,
      listeners: 0,
      held: null,
      congested: false,
      turnedAway: 0,
      guest: null,
      guestDeck: 'B',
      error: null,
      via: 'direct',
      relay: null,
      relayState: 'off',
      relayError: '',
      joined: 'off',
      joinError: null,
      hostDeck: 'B',
      snap: null,
      lib: [],
      libMsg: '',
    })
    const off = desktop?.onLive?.((ev) => void this.signal(ev))
    // The window started again mid-set (PANIC restart): stay on air. The pages reconnect by themselves.
    void desktop?.liveInfo?.().then(async (info) => {
      if (!info?.on || this.state.on) return
      const fresh = await desktop?.liveReset?.()
      if (fresh?.on) {
        this.goOnAir(fresh)
        if (fresh.reach !== 'open') void this.startRelay()
      }
    })
    this.dispose = () => {
      off?.()
      this.stop()
      this.leave()
    }
  }

  // ───────────────────────── host ─────────────────────────

  async start(): Promise<void> {
    if (!desktop?.liveStart || this.state.busy || this.state.on) return
    if (this.state.joined !== 'off') this.leave()
    this.set({ busy: true, error: null })
    const info = await desktop.liveStart()
    if (!info?.on) {
      this.set({ busy: false, error: info?.error ?? 'Could not start the live server.' })
      return
    }
    this.goOnAir(info)
    // The internet cannot reach this Mac directly: through the DJ's own server instead.
    if (info.reach !== 'open') await this.startRelay()
  }

  /** Publish the master to the relay server (the app connects out, so any home network works). */
  async startRelay(): Promise<void> {
    const cfg = relayConfig()
    if (!cfg.url) {
      this.set({ relayState: 'none', relayError: '' })
      return
    }
    if (!this.tap || this.room) return
    this.set({ relayState: 'connecting', relayError: '' })
    let set: RelaySet | null = null
    try {
      // After a reload (PANIC restart) the same set, so the shared links keep working.
      const kept = rememberedSet()
      set = kept && kept.cfg.url === cfg.url && (await keepRelaySet(cfg, kept.set)) ? kept.set : await openRelaySet(cfg)
      rememberSet({ cfg, set })
      const LK = await import('livekit-client')
      const room = new LK.Room({ adaptiveStream: false, dynacast: false })
      this.room = room
      this.relaySet = { cfg, set }
      const recount = () => this.recount()
      room.on(LK.RoomEvent.ParticipantConnected, (p) => {
        recount()
        if (p.identity === 'guest') {
          this.set({ guest: { id: -1, connected: true } })
          this.lastSnap = ''
          this.relaySend({ t: 'role', deck: this.state.guestDeck }, ['guest'])
          midi.say('Guest joined · deck ' + this.state.guestDeck)
        } else this.relaySend(JSON.parse(this.lastNow || '{"t":"now"}'), [p.identity])
      })
      room.on(LK.RoomEvent.ParticipantDisconnected, (p) => {
        recount()
        if (p.identity === 'guest' && this.state.guest?.id === -1) {
          this.set({ guest: null })
          midi.say('Guest left')
        }
      })
      room.on(LK.RoomEvent.DataReceived, (payload, from) => {
        // Only the guest's token may send data (listeners' cannot: the server's grants), so a packet
        // that arrives before LiveKit has introduced its sender (no `from` yet) is the guest's too.
        if ((from && from.identity !== 'guest') || payload.byteLength > 4000) return
        let m: unknown
        try {
          m = JSON.parse(dec.decode(payload))
        } catch {
          return
        }
        if (m && typeof m === 'object')
          controlMessage(m as Record<string, unknown>, (text) => this.relaySendText(text, ['guest']), 'Guest', this.state.guestDeck)
      })
      room.on(LK.RoomEvent.Disconnected, () => {
        if (this.room !== room) return
        this.room = null
        if (this.state.on) this.set({ relayState: 'error', relayError: 'Lost the server.', via: 'direct' })
      })
      await room.connect(set.ws, set.token)
      // Already in the room (this window reloaded mid-set): the listeners and the guest.
      this.recount()
      if (room.remoteParticipants.has('guest')) {
        this.set({ guest: { id: -1, connected: true } })
        this.relaySend({ t: 'role', deck: this.state.guestDeck }, ['guest'])
      }
      const track = this.tap!.stream.getAudioTracks()[0]
      await room.localParticipant.publishTrack(track, { ...MUSIC_PUBLISH, source: LK.Track.Source.Microphone, audioPreset: { maxBitrate: BITRATE } })
      if (this.room !== room) return // stopped meanwhile
      this.set({ via: 'relay', relay: { listen: set.listen, guest: set.guest }, relayState: 'on' })
      const alive = set
      this.heartbeat = window.setInterval(async () => {
        if (this.room === room && !(await keepRelaySet(cfg, alive))) this.set({ relayState: 'error', relayError: 'The server ended this set.' })
      }, 60000)
      this.lastNow = ''
    } catch (e) {
      console.warn('live: relay', e)
      this.room?.disconnect()
      this.room = null
      if (set) endRelaySet(cfg, set)
      rememberSet(null)
      this.relaySet = null
      this.set({ relayState: 'error', relayError: e instanceof Error ? e.message : String(e) })
    }
  }

  private relaySendText(text: string, to?: string[]): void {
    const room = this.room
    if (!room || room.state !== 'connected') return
    void room.localParticipant.publishData(enc.encode(text), { reliable: true, destinationIdentities: to }).catch(() => undefined)
  }

  private relaySend(o: object, to?: string[]): void {
    this.relaySendText(JSON.stringify(o), to)
  }

  private stopRelay(): void {
    const room = this.room
    if (room) {
      this.relaySendText(JSON.stringify({ t: 'off' })) // listeners and guest hear it's over
      window.setTimeout(() => void room.disconnect(), 300) // let the goodbye go out first
    }
    this.room = null
    window.clearInterval(this.heartbeat)
    if (this.relaySet) endRelaySet(this.relaySet.cfg, this.relaySet.set)
    rememberSet(null)
    this.relaySet = null
  }

  /** The finished master, through a gate that silences what may not be broadcast. */
  private goOnAir(info: LiveInfo): void {
    const ctx = mixer.ctx
    this.gate = ctx.createGain()
    this.tap = ctx.createMediaStreamDestination()
    this.tap.channelCount = 2
    mixer.masterOut.connect(this.gate)
    this.gate.connect(this.tap)
    this.set({ busy: false, on: true, info, error: null, listeners: 0, guest: null, congested: false, turnedAway: 0, via: 'direct', relay: null, relayState: 'off', relayError: '' })
    this.timer = window.setInterval(() => this.tick(), 100)
    this.tick()
  }

  stop(): void {
    if (!this.state.on) return
    for (const [id, c] of this.calls) {
      if (c.role === 'listen') reply(id, { t: 'off' })
      c.pc.close()
    }
    this.calls.clear()
    this.stopRelay()
    window.clearInterval(this.timer)
    if (this.gate) {
      mixer.masterOut.disconnect(this.gate) // only our link: speakers, headphones, recording keep theirs
      this.gate.disconnect()
    }
    this.gate = null
    this.tap = null
    this.lastNow = ''
    this.lastSnap = ''
    void desktop?.liveStop?.()
    this.set({ on: false, info: null, listeners: 0, guest: null, held: null, via: 'direct', relay: null, relayState: 'off', relayError: '' })
  }

  /** The best link to share: the internet one when the router opened the port, else this network's. */
  shareLink(which: keyof LiveLinks, where: 'best' | 'public' | 'lan' = 'best'): string {
    const i = this.state.info
    if (!i) return ''
    if (this.state.relay && where !== 'lan') return this.state.relay[which]
    if (where === 'public') return i.public[which]
    if (where === 'lan') return i.lanIp[which] || i.local[which]
    return (i.reach === 'open' && i.public[which]) || i.lanIp[which] || i.local[which]
  }

  setGuestDeck(d: 'A' | 'B'): void {
    this.set({ guestDeck: d })
    if (this.state.guest?.id === -1) return this.relaySend({ t: 'role', deck: d }, ['guest'])
    const g = this.state.guest && this.calls.get(this.state.guest.id)
    if (g?.dc?.readyState === 'open') g.dc.send(JSON.stringify({ t: 'role', deck: d }))
  }

  kickGuest(): void {
    const g = this.state.guest
    if (!g) return
    if (g.id === -1) return this.relaySend({ t: 'kick' }, ['guest']) // its app leaves on this
    desktop?.liveKick?.(g.id)
  }

  private async refreshInfo(): Promise<void> {
    const info = await desktop?.liveInfo?.()
    if (info && this.state.on) this.set({ info })
  }

  private async signal(ev: LiveSignal): Promise<void> {
    if (!this.state.on) return
    if (ev.t === 'join') {
      if (ev.role === 'guest' && this.state.guest?.id === -1) {
        desktop?.liveKick?.(ev.id) // one guest: the one on the relay is already in
        return
      }
      if (ev.role === 'guest') this.set({ guest: { id: ev.id, connected: false } })
      void this.refreshInfo()
      return
    }
    if (ev.t === 'leave') {
      this.calls.get(ev.id)?.pc.close()
      this.calls.delete(ev.id)
      if (this.state.guest?.id === ev.id) {
        this.set({ guest: null })
        midi.say('Guest left')
      }
      this.recount()
      void this.refreshInfo()
      return
    }
    const msg = ev.msg ?? {}
    if (msg.t === 'hello') {
      if (ev.role === 'listen' && this.state.congested && !this.calls.has(ev.id)) {
        // The upload is full: one more would make it stutter for everyone. The page says so.
        reply(ev.id, { t: 'full' })
        this.set({ turnedAway: this.state.turnedAway + 1 })
        return
      }
      return this.call(ev.id, ev.role)
    }
    if (msg.t === 'answer' && typeof msg.sdp === 'string' && msg.sdp.length < 60000) {
      const c = this.calls.get(ev.id)
      if (!c) return
      try {
        await c.pc.setRemoteDescription({ type: 'answer', sdp: musicOpus(msg.sdp) })
      } catch (e) {
        console.warn('live: bad answer', e)
        desktop?.liveKick?.(ev.id)
      }
    }
  }

  /** A listener or the guest said hello: call it with the master (and, for the guest, the control channel). */
  private async call(id: number, role: 'listen' | 'guest'): Promise<void> {
    if (!this.tap) return
    this.calls.get(id)?.pc.close()
    const pc = new RTCPeerConnection({ iceServers: ICE })
    const entry: { pc: RTCPeerConnection; role: 'listen' | 'guest'; dc?: RTCDataChannel } = { pc, role }
    this.calls.set(id, entry)
    const track = this.tap.stream.getAudioTracks()[0]
    const sender = pc.addTrack(track, this.tap.stream)
    if (role === 'guest') {
      const dc = pc.createDataChannel('ctl', { ordered: true })
      entry.dc = dc
      dc.onopen = () => {
        this.lastSnap = ''
        dc.send(JSON.stringify({ t: 'role', deck: this.state.guestDeck }))
        if (this.state.guest?.id === id) this.set({ guest: { id, connected: true } })
        midi.say('Guest joined · deck ' + this.state.guestDeck)
      }
      dc.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data.length > 4000) return
        let m: unknown
        try {
          m = JSON.parse(e.data)
        } catch {
          return
        }
        if (m && typeof m === 'object' && dc.readyState === 'open')
          controlMessage(m as Record<string, unknown>, (text) => dc.readyState === 'open' && dc.send(text), 'Guest', this.state.guestDeck)
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') desktop?.liveKick?.(id)
      this.recount()
    }
    try {
      const p = sender.getParameters()
      if (p.encodings?.[0]) {
        p.encodings[0].maxBitrate = BITRATE
        await sender.setParameters(p)
      }
    } catch {
      /* the default rate then */
    }
    try {
      await pc.setLocalDescription(await pc.createOffer())
      await gathered(pc, 2500)
      if (this.calls.get(id)?.pc !== pc) return
      reply(id, { t: 'offer', sdp: pc.localDescription?.sdp })
      this.lastNow = '' // the newcomer gets what is playing
    } catch (e) {
      console.warn('live: could not call', e)
      desktop?.liveKick?.(id)
    }
  }

  private recount(): void {
    let n = 0
    for (const c of this.calls.values()) if (c.role === 'listen' && c.pc.connectionState === 'connected') n++
    if (this.room) for (const p of this.room.remoteParticipants.values()) if (p.identity.startsWith('l-')) n++
    if (n === this.state.listeners) return
    this.set({ listeners: n })
    for (const [id, c] of this.calls) if (c.role === 'listen') reply(id, { t: 'count', n })
  }

  /** Ten times a second: the gate, what is playing for the listeners, the decks for the guest. */
  private ticks = 0
  private checking = false
  private clean = 0

  /**
   * Is the upload keeping up? Every 2 s, the listeners' own reports (RTCP): lost packets and round
   * trip. When it struggles, everyone drops to a lower rate and newcomers are turned away (the cap
   * follows the real line, not a guess); when it recovers, back to full quality.
   */
  private async checkUpload(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      let bad = 0
      let n = 0
      for (const c of this.calls.values()) {
        if (c.role !== 'listen' || c.pc.connectionState !== 'connected') continue
        n++
        const stats = await c.pc.getStats()
        stats.forEach((r: RTCStats & { fractionLost?: number; roundTripTime?: number }) => {
          if (r.type === 'remote-inbound-rtp' && ((r.fractionLost ?? 0) > 0.05 || (r.roundTripTime ?? 0) > 0.6)) bad++
        })
      }
      // Two struggling listeners (or one, when they are few) is the line, not one listener's Wi-Fi.
      // Back to full quality only after 10 s without trouble (no flapping between the two rates).
      const struggling = n > 0 && bad >= Math.min(2, n)
      this.clean = struggling ? 0 : this.clean + 1
      const congested = struggling || (this.state.congested && this.clean < 5)
      if (congested !== this.state.congested) {
        this.set({ congested })
        for (const c of this.calls.values()) {
          const sender = c.pc.getSenders()[0]
          const p = sender?.getParameters()
          if (!p?.encodings?.[0]) continue
          p.encodings[0].maxBitrate = congested ? LOW_BITRATE : BITRATE
          await sender.setParameters(p).catch(() => undefined)
        }
      }
    } finally {
      this.checking = false
    }
  }

  private tick(): void {
    if (++this.ticks % 20 === 0) void this.checkUpload()
    // YouTube / Spotify audible in the master: the broadcast goes silent until it is not.
    const banned = decks.find((d, i) => {
      const s = d.get()
      return s.playing && (s.kind === 'youtube' || s.kind === 'spotify') && s.volume > 0.01 && mixer.sideGain(i as 0 | 1) > 0.01
    })
    const held = banned ? 'Deck ' + banned.name + ' plays ' + (banned.get().kind === 'youtube' ? 'YouTube' : 'Spotify') + ': not broadcast' : null
    if (held !== this.state.held) {
      this.set({ held })
      this.gate?.gain.setTargetAtTime(held ? 0 : 1, mixer.ctx.currentTime, 0.05)
    }
    // Now playing: the louder deck on air.
    const onAir = decks
      .map((d, i) => ({ s: d.get(), g: mixer.sideGain(i as 0 | 1) }))
      .filter((x) => x.s.playing && x.s.kind === 'local')
      .sort((a, b) => b.s.volume * b.g - a.s.volume * a.g)[0]
    const now = JSON.stringify(held ? { t: 'now', title: 'Back in a moment', artist: '' } : { t: 'now', title: onAir?.s.title ?? '', artist: onAir?.s.artist ?? '' })
    if (now !== this.lastNow) {
      this.lastNow = now
      for (const [id, c] of this.calls) if (c.role === 'listen') desktop?.liveSend?.(id, now)
      this.relaySendText(now)
    }
    if (this.state.guest?.id === -1) {
      const text = JSON.stringify(snapshot())
      if (text !== this.lastSnap) {
        this.lastSnap = text
        this.relaySendText(text, ['guest'])
      }
    }
    const g = this.state.guest && this.calls.get(this.state.guest.id)
    if (g?.dc?.readyState === 'open') {
      const text = JSON.stringify(snapshot())
      if (text !== this.lastSnap) {
        this.lastSnap = text
        g.dc.send(text)
      }
    }
  }

  // ───────────────────────── guest ─────────────────────────

  /** Join someone's set with their invite link (https://…/?g=…). */
  join(link: string): void {
    if (this.state.on) return
    this.leave()
    let url: URL
    try {
      url = new URL(link.trim())
    } catch {
      this.set({ joined: 'error', joinError: 'That is not a link.' })
      return
    }
    const code = url.searchParams.get('g')
    if (!code || !/^https?:$/.test(url.protocol)) {
      this.set({ joined: 'error', joinError: 'Paste the INVITE link (the listen link only plays the mix).' })
      return
    }
    this.set({ joined: 'connecting', joinError: null, snap: null, lib: [], libMsg: '' })
    void this.joinAny(url, code)
  }

  /** The invite may point at the host's own server (relay) or straight at the host's Mac. */
  private async joinAny(url: URL, code: string): Promise<void> {
    let relay: { ws: string; token: string } | null = null
    try {
      relay = await relayGuestToken(url, code)
    } catch (e) {
      this.set({ joined: 'error', joinError: e instanceof Error ? e.message : 'The set is not on air.' })
      return
    }
    if (this.state.joined !== 'connecting') return // left meanwhile
    if (relay) return this.joinRelay(relay)
    const ws = (this.ws = new WebSocket((url.protocol === 'https:' ? 'wss://' : 'ws://') + url.host + '/ws?g=' + encodeURIComponent(code)))
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello' }))
    ws.onclose = () => {
      if (this.ws !== ws) return
      const was = this.state.joined
      this.leave()
      this.set({ joined: 'error', joinError: was === 'on' ? 'The host ended the session.' : 'Could not reach the host (the set is off, or a guest is already in).' })
    }
    ws.onmessage = (e) => {
      let m: { t?: string; sdp?: string }
      try {
        m = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (m.t === 'offer' && typeof m.sdp === 'string') void this.answer(m.sdp)
    }
  }

  /** Through the host's server: their master as a track, the controls as data messages. */
  private async joinRelay(t: { ws: string; token: string }): Promise<void> {
    const LK = await import('livekit-client')
    const room = new LK.Room({ adaptiveStream: false, dynacast: false })
    this.guestRoom = room
    room.on(LK.RoomEvent.TrackSubscribed, (track, _pub, who) => {
      if (track.kind !== 'audio' || who.identity !== 'host') return
      const r = track.receiver as (RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number }) | undefined
      try {
        if (r) {
          r.jitterBufferTarget = 0
          r.playoutDelayHint = 0
        }
      } catch {
        /* older engine */
      }
      this.playHost(new MediaStream([track.mediaStreamTrack]))
    })
    room.on(LK.RoomEvent.DataReceived, (payload, from) => {
      if (from?.identity !== 'host') return
      let m: Record<string, unknown>
      try {
        m = JSON.parse(dec.decode(payload))
      } catch {
        return
      }
      if (m.t === 'off' || m.t === 'kick') {
        this.leave()
        this.set({ joined: 'error', joinError: m.t === 'off' ? 'The host ended the session.' : 'The host ended your turn.' })
        return
      }
      this.hostMessage(m)
    })
    // The host left the room (stopped, or its app closed): the session is over.
    // The host left the room: a PANIC restart comes back within seconds; anything longer is the end.
    let gone = 0
    room.on(LK.RoomEvent.ParticipantDisconnected, (p) => {
      if (p.identity !== 'host' || this.guestRoom !== room) return
      gone = window.setTimeout(() => {
        if (this.guestRoom !== room || room.remoteParticipants.has('host')) return
        this.leave()
        this.set({ joined: 'error', joinError: 'The host ended the session.' })
      }, 20000)
    })
    room.on(LK.RoomEvent.ParticipantConnected, (p) => {
      if (p.identity === 'host') window.clearTimeout(gone)
    })
    room.on(LK.RoomEvent.Disconnected, () => {
      if (this.guestRoom !== room) return
      const was = this.state.joined
      this.leave()
      this.set({ joined: 'error', joinError: was === 'on' ? 'The host ended the session.' : 'Could not reach the host.' })
    })
    try {
      await room.connect(t.ws, t.token)
      if (this.guestRoom !== room) return
      this.sendChain = Promise.resolve()
      this.send({ t: 'hello' })
      this.send({ t: 'lib', q: '' })
      await this.sendChain // the data channel to the host is up once this is through
      if (this.guestRoom !== room) return
      this.set({ joined: 'on' })
    } catch (e) {
      if (this.guestRoom !== room) return
      this.leave()
      this.set({ joined: 'error', joinError: 'Could not reach the host’s server.' })
    }
  }

  /** The host's master, on this app's own master output. */
  private playHost(stream: MediaStream): void {
    const out = (this.out ??= new Audio())
    out.srcObject = stream
    const sink = mixer.get().masterDevice
    if (sink && sink !== 'split') void (out as HTMLAudioElement & { setSinkId?(id: string): Promise<void> }).setSinkId?.(sink).catch(() => undefined)
    void out.play().catch(() => undefined)
  }

  /** What the host sends the guest: the decks, its deck, the library, load results. */
  private hostMessage(m: Record<string, unknown>): void {
    if (m.t === 's') this.set({ snap: m as unknown as Snap })
    else if (m.t === 'role' && (m.deck === 'A' || m.deck === 'B')) this.set({ hostDeck: m.deck })
    else if (m.t === 'lib' && Array.isArray(m.items)) this.set({ lib: (m.items as LibItem[]).slice(0, 200) })
    else if (m.t === 'load') this.set({ libMsg: m.ok ? '' : String(m.error ?? 'Could not load.') })
  }

  private async answer(sdp: string): Promise<void> {
    this.pc?.close()
    const pc = (this.pc = new RTCPeerConnection({ iceServers: ICE }))
    pc.ontrack = (ev) => {
      // As little buffering as the network allows (the guest plays along with what it hears).
      const r = ev.receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number }
      try {
        r.jitterBufferTarget = 0
        r.playoutDelayHint = 0
      } catch {
        /* older engine */
      }
      this.playHost(ev.streams[0] ?? new MediaStream([ev.track]))
    }
    pc.ondatachannel = (ev) => {
      const dc = (this.dc = ev.channel)
      dc.onopen = () => {
        this.set({ joined: 'on' })
        this.send({ t: 'hello' })
        this.send({ t: 'lib', q: '' })
      }
      dc.onmessage = (e) => {
        let m: Record<string, unknown>
        try {
          m = JSON.parse(String(e.data))
        } catch {
          return
        }
        this.hostMessage(m)
      }
      dc.onclose = () => this.dc === dc && this.state.joined === 'on' && this.ws?.close()
    }
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && pc.connectionState === 'failed') {
        this.leave()
        this.set({ joined: 'error', joinError: 'The network between you and the host blocked the call.' })
      }
    }
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription({ type: 'answer', sdp: musicOpus(answer.sdp ?? '') })
      await gathered(pc, 2500)
      this.ws?.send(JSON.stringify({ t: 'answer', sdp: pc.localDescription?.sdp }))
    } catch (e) {
      console.warn('guest: could not answer', e)
      this.leave()
      this.set({ joined: 'error', joinError: 'Could not set up the call.' })
    }
  }

  /** A controller message to the host (same shape as the phone's: { t: 'a', id, v } …). */
  send(o: object): void {
    const room = this.guestRoom
    if (room?.state === 'connected') {
      const data = enc.encode(JSON.stringify(o))
      this.sendChain = this.sendChain.then(() => room.localParticipant.publishData(data, { reliable: true, destinationIdentities: ['host'] })).catch(() => undefined)
      return
    }
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(o))
  }

  /** An action on the deck the host gave us ('play', 'cue', 'volume'…). */
  act(name: string, v = 1): void {
    this.send({ t: 'a', id: 'deck' + this.state.hostDeck + '.' + name, v })
  }

  leave(): void {
    const room = this.guestRoom
    this.guestRoom = null
    void room?.disconnect()
    const ws = this.ws
    this.ws = null
    ws?.close()
    this.dc?.close()
    this.dc = null
    this.pc?.close()
    this.pc = null
    if (this.out) {
      this.out.pause()
      this.out.srcObject = null
    }
    if (this.state.joined !== 'off') this.set({ joined: 'off', joinError: null, snap: null, lib: [], libMsg: '' })
  }

  clearJoinError(): void {
    this.set({ joined: 'off', joinError: null })
  }
}

export const live = new Live()

// Editing this file while the app runs: the old one hangs up, so nothing is sent twice.
import.meta.hot?.dispose(() => live.dispose())
