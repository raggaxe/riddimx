import type { Room } from 'livekit-client'
import { Store } from './store'
import { remote, controlMessage, snapshot } from './remote'
import { mic } from './engine/mic'
import { liveFeatures, relayConfig, type RelayConfig } from './relay'

/**
 * The phone controller from anywhere (4G, another network): while Phone is on in Settings and the
 * app has a RiddimX server, the app keeps a room there ("desk") and phones join it through the
 * server's https link. Same page, same messages and same pairing code as on the Wi-Fi; only the
 * road changes. A phone's microphone arrives as a track in that room.
 */
export interface PhoneRelayState {
  state: 'off' | 'none' | 'connecting' | 'on' | 'error' // 'none': no server set up in this app
  url: string // the phone's link (with the pairing code)
  phones: number
  error: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

class PhoneRelay extends Store<PhoneRelayState> {
  private room: Room | null = null
  private code = ''
  private cfg: RelayConfig | null = null
  private roomName = ''
  private timer = 0
  private heartbeat = 0
  private lastSent = ''
  private micFrom = ''
  private gen = 0
  dispose: () => void = () => undefined

  constructor() {
    super({ state: 'off', url: '', phones: 0, error: '' })
    if (!liveFeatures) return // still in development: the phone works on the Wi-Fi only
    const off = remote.subscribe(() => this.follow())
    this.follow()
    this.dispose = () => {
      off()
      this.disconnect()
    }
  }

  /** The pairing code of the Wi-Fi link (?k=…): the same code works from anywhere. */
  private currentCode(): string {
    const r = remote.get()
    if (!r.on) return ''
    for (const u of r.urls) {
      const k = /[?&]k=([0-9a-f]+)/.exec(u)?.[1]
      if (k) return k
    }
    return ''
  }

  /** Phone on: be in the room; off or a new code: leave (and join the new one). */
  private follow(): void {
    const code = this.currentCode()
    if (code === this.code) return
    this.disconnect()
    this.code = code
    if (code) void this.connect()
  }

  /** Try again (after setting up a server in the LIVE panel, for instance). */
  retry(): void {
    this.disconnect()
    this.code = this.currentCode()
    if (this.code) void this.connect()
  }

  private async connect(): Promise<void> {
    const cfg = relayConfig()
    if (!cfg.url) {
      this.set({ state: 'none', url: '', error: '' })
      return
    }
    const gen = ++this.gen
    this.cfg = cfg
    this.set({ state: 'connecting', error: '' })
    try {
      const res = await fetch(cfg.url + '/api/remote', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: this.code }),
      })
      const t = (await res.json()) as { ws: string; room: string; token: string; url: string; error?: string }
      if (!res.ok) throw new Error(t.error || 'The server answered ' + res.status)
      if (gen !== this.gen) return
      const LK = await import('livekit-client')
      const room = new LK.Room({ adaptiveStream: false, dynacast: false })
      this.room = room
      this.roomName = t.room
      const count = () => {
        const phones = [...room.remoteParticipants.keys()].filter((id) => id.startsWith('phone-')).length
        this.set({ phones })
        this.lastSent = '' // a new phone gets everything at once
        this.pump()
      }
      room.on(LK.RoomEvent.ParticipantConnected, count)
      room.on(LK.RoomEvent.ParticipantDisconnected, (p) => {
        count()
        if (p.identity === this.micFrom) this.micOff()
      })
      room.on(LK.RoomEvent.DataReceived, (payload, from) => {
        // Only phones can send here (the server's grants); before LiveKit introduces one, `from` is empty.
        if ((from && !from.identity.startsWith('phone-')) || payload.byteLength > 4000) return
        let msg: unknown
        try {
          msg = JSON.parse(dec.decode(payload))
        } catch {
          return
        }
        if (!msg || typeof msg !== 'object') return
        const m = msg as Record<string, unknown>
        if (m.t === 'rtc' || m.t === 'rtc-stop') return // the microphone comes as a track here
        const to = from ? [from.identity] : undefined
        controlMessage(m, (text) => this.publish(text, to), 'Phone')
      })
      room.on(LK.RoomEvent.TrackSubscribed, (track, _pub, who) => {
        if (track.kind !== 'audio' || !who.identity.startsWith('phone-')) return
        this.micFrom = who.identity
        mic.usePhone(new MediaStream([track.mediaStreamTrack]))
      })
      room.on(LK.RoomEvent.TrackUnsubscribed, (_track, _pub, who) => who.identity === this.micFrom && this.micOff())
      room.on(LK.RoomEvent.Disconnected, () => {
        if (this.room !== room) return
        this.room = null
        this.set({ state: 'error', error: 'Lost the server.', phones: 0 })
      })
      await room.connect(t.ws, t.token)
      if (gen !== this.gen) return void room.disconnect()
      this.set({ state: 'on', url: t.url, error: '' })
      count()
      this.heartbeat = window.setInterval(() => {
        void fetch(cfg.url + '/api/remote/' + t.room, { method: 'PUT', headers: { Authorization: 'Bearer ' + this.code } }).catch(() => undefined)
      }, 60000)
    } catch (e) {
      if (gen !== this.gen) return
      this.room?.disconnect()
      this.room = null
      this.set({ state: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }

  private micOff(): void {
    this.micFrom = ''
    if (mic.get().phone) mic.usePhone(null)
  }

  private publish(text: string, to?: string[]): void {
    const room = this.room
    if (!room || room.state !== 'connected') return
    void room.localParticipant.publishData(enc.encode(text), { reliable: true, destinationIdentities: to }).catch(() => undefined)
  }

  /** The decks' state to the phones, about 12 times a second while one is in, only when it changed. */
  private pump(): void {
    window.clearInterval(this.timer)
    if (!this.state.phones) return
    this.timer = window.setInterval(() => {
      const text = JSON.stringify(snapshot())
      if (text === this.lastSent) return
      this.lastSent = text
      this.publish(text)
    }, 80)
  }

  private disconnect(): void {
    this.gen++
    window.clearInterval(this.timer)
    window.clearInterval(this.heartbeat)
    if (this.micFrom) this.micOff()
    const room = this.room
    this.room = null
    void room?.disconnect()
    if (this.cfg && this.roomName && this.code)
      void fetch(this.cfg.url + '/api/remote/' + this.roomName, { method: 'DELETE', headers: { Authorization: 'Bearer ' + this.code } }).catch(() => undefined)
    this.roomName = ''
    if (this.state.state !== 'off') this.set({ state: 'off', url: '', phones: 0, error: '' })
  }
}

export const phoneRelay = new PhoneRelay()

// Editing this file while the app runs: the old one leaves the room, so messages are not run twice.
import.meta.hot?.dispose(() => phoneRelay.dispose())
