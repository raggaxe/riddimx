import { mic } from './engine/mic'

/**
 * The phone's microphone, received over Wi-Fi as a WebRTC call from the phone's page. The offer and
 * the answer travel over the controller's socket, each with all its network candidates already in
 * it (no trickling), which is enough on one local network. The voice then feeds the app's mic.
 */
let call: { pc: RTCPeerConnection; client: number } | null = null

function hangUp(): void {
  if (!call) return
  const old = call
  call = null
  old.pc.close()
  mic.usePhone(null)
}

/** All the network candidates are in, or a second has passed (enough on a LAN). */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    pc.addEventListener('icegatheringstatechange', check)
    window.setTimeout(done, 1000)
  })
}

/** An offer from a phone: answer it, and its microphone becomes the voice's input. Returns the answer. */
export async function phoneOffer(sdp: string, client: number): Promise<string | null> {
  hangUp() // one phone microphone at a time: the newest wins
  const pc = new RTCPeerConnection({ iceServers: [] })
  call = { pc, client }
  pc.addEventListener('track', (e) => {
    // Live voice: keep the receive buffer as short as the network allows.
    const r = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number }
    try {
      r.jitterBufferTarget = 0
      r.playoutDelayHint = 0
    } catch {
      /* older engine */
    }
    const stream = e.streams[0] ?? new MediaStream([e.track])
    mic.usePhone(stream)
  })
  pc.addEventListener('connectionstatechange', () => {
    if (call?.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) hangUp()
  })
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp })
    await pc.setLocalDescription(await pc.createAnswer())
    await gathered(pc)
    return pc.localDescription?.sdp ?? null
  } catch (e) {
    console.warn('phone mic: could not answer', e)
    if (call?.pc === pc) hangUp()
    return null
  }
}

/** The phone stopped its microphone (or left). */
export function phoneHangUp(client?: number): void {
  if (call && (client === undefined || call.client === client)) hangUp()
}
