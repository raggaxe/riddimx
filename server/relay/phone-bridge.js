/**
 * The phone controller from anywhere: remote.html normally talks to the Mac over a WebSocket on the
 * Wi-Fi. Served by the relay, it gets this instead: an object with the same shape (onopen, onmessage,
 * onclose, readyState, send) that goes through the LiveKit room the app keeps on the server.
 * The phone's microphone goes up as a track in the same room (publishMic).
 */
;(() => {
  const LK = window.LivekitClient
  if (!LK) return
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  class RxSocket {
    constructor(key) {
      this.readyState = 0
      this.onopen = this.onmessage = this.onclose = null
      this.room = null
      this.chain = Promise.resolve()
      this.mic = null
      void this.open(key)
    }

    async open(key) {
      let t
      try {
        const r = await fetch('/api/token?r=' + encodeURIComponent(key), { cache: 'no-store' })
        t = await r.json()
        if (!r.ok) throw new Error(t.error || 'off')
      } catch (e) {
        window.RxOffline && window.RxOffline(e.message)
        return this.close()
      }
      const room = (this.room = new LK.Room({ adaptiveStream: false, dynacast: false }))
      room.on(LK.RoomEvent.DataReceived, (payload, from) => {
        if (from && from.identity !== 'desk') return
        this.onmessage && this.onmessage({ data: dec.decode(payload) })
      })
      // The app went away (closed, phone turned off in Settings): show "connecting" and try again.
      room.on(LK.RoomEvent.ParticipantDisconnected, (p) => p.identity === 'desk' && this.close())
      room.on(LK.RoomEvent.Disconnected, () => this.close())
      try {
        await room.connect(t.ws, t.token)
      } catch (e) {
        return this.close()
      }
      // Wait for the app to be in the room (it may be reconnecting).
      for (let i = 0; i < 30 && !room.remoteParticipants.has('desk'); i++) await new Promise((r) => setTimeout(r, 200))
      if (!room.remoteParticipants.has('desk')) {
        window.RxOffline && window.RxOffline('RiddimX is not open on the Mac.')
        return this.close()
      }
      this.readyState = 1
      this.onopen && this.onopen()
    }

    send(text) {
      const room = this.room
      if (this.readyState !== 1 || !room) return
      const data = enc.encode(text)
      // In order (a fader's moves), and the first waits for the data channel to open.
      this.chain = this.chain.then(() => room.localParticipant.publishData(data, { reliable: true, destinationIdentities: ['desk'] })).catch(() => undefined)
    }

    /** The phone's microphone to the Mac (instead of a direct call, which needs the same Wi-Fi). */
    async publishMic(stream) {
      const track = stream.getAudioTracks()[0]
      if (!this.room || !track) throw new Error('not connected')
      this.mic = await this.room.localParticipant.publishTrack(track, { source: LK.Track.Source.Microphone, name: 'phone-mic', dtx: false, red: true })
    }

    async unpublishMic() {
      if (this.mic && this.room) await this.room.localParticipant.unpublishTrack(this.mic.track, false).catch(() => undefined)
      this.mic = null
    }

    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      const room = this.room
      this.room = null
      if (room) void room.disconnect()
      this.onclose && this.onclose()
    }
  }

  window.RxSocket = RxSocket
})()
