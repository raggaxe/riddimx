/**
 * The DJ's own relay server (server/ in this repo: LiveKit + a small token endpoint), used when the
 * home network cannot be reached from the internet. The app connects OUT to it, so it works behind
 * double NAT and CGNAT with nothing to set up; listeners there cost the server's upload, not the DJ's.
 *
 * Its address and key are built into the app (VITE_RELAY_URL / VITE_RELAY_KEY); the LIVE panel can
 * override them on this computer (for testing a server).
 */
const LS = 'vx_relay'

export interface RelayConfig {
  url: string
  key: string
}

export interface RelaySet {
  ws: string
  room: string
  hostSecret: string
  token: string
  listen: string
  guest: string
}

const built: RelayConfig = {
  url: String(import.meta.env.VITE_RELAY_URL ?? ''),
  key: String(import.meta.env.VITE_RELAY_KEY ?? ''),
}

/**
 * GO LIVE, guest co-DJ and the phone from anywhere are still being built: only development builds
 * (npm run dev / desktop) show them. A packaged app for clients has none of it.
 */
export const liveFeatures = import.meta.env.DEV

/** The SERVER field (LIVE panel) exists only in development: a client's app always uses the built-in server. */
export const relayEditable = import.meta.env.DEV

export function relayConfig(): RelayConfig {
  if (!relayEditable) return { ...built, url: built.url.replace(/\/$/, '') }
  try {
    const own = JSON.parse(localStorage.getItem(LS) ?? 'null') as Partial<RelayConfig> | null
    if (own?.url) return { url: own.url.replace(/\/$/, ''), key: own.key ?? '' }
  } catch {
    /* the built-in one */
  }
  return { ...built, url: built.url.replace(/\/$/, '') }
}

/** This computer's own server (empty url: back to the built-in one). */
export function setRelayConfig(c: RelayConfig): void {
  try {
    if (c.url.trim()) localStorage.setItem(LS, JSON.stringify({ url: c.url.trim(), key: c.key.trim() }))
    else localStorage.removeItem(LS)
  } catch {
    /* not remembered */
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error || 'The server answered ' + res.status)
  return body
}

const timeout = (ms: number) => {
  const c = new AbortController()
  window.setTimeout(() => c.abort(), ms)
  return c.signal
}

/** A new set on the server: the host's room token and the links to share. */
export async function openRelaySet(c: RelayConfig): Promise<RelaySet> {
  const res = await fetch(c.url + '/api/session', { method: 'POST', headers: { Authorization: 'Bearer ' + c.key }, signal: timeout(8000) })
  return json<RelaySet>(res)
}

/** "Still on air" (every minute): false when the server already dropped the set. */
export async function keepRelaySet(c: RelayConfig, set: RelaySet): Promise<boolean> {
  try {
    const res = await fetch(c.url + '/api/session/' + set.room, { method: 'PUT', headers: { Authorization: 'Bearer ' + set.hostSecret }, signal: timeout(8000) })
    return res.ok
  } catch {
    return true // the server is out of reach for a moment: LiveKit says if the room is really lost
  }
}

/** The set of this window, kept across a reload (PANIC restart) so the links stay the same. */
const SS = 'vx_relay_set'
export function rememberSet(v: { cfg: RelayConfig; set: RelaySet } | null): void {
  try {
    if (v) sessionStorage.setItem(SS, JSON.stringify(v))
    else sessionStorage.removeItem(SS)
  } catch {
    /* a reload starts a new set */
  }
}
export function rememberedSet(): { cfg: RelayConfig; set: RelaySet } | null {
  try {
    return JSON.parse(sessionStorage.getItem(SS) ?? 'null')
  } catch {
    return null
  }
}

export function endRelaySet(c: RelayConfig, set: RelaySet): void {
  void fetch(c.url + '/api/session/' + set.room, { method: 'DELETE', headers: { Authorization: 'Bearer ' + set.hostSecret } }).catch(() => undefined)
}

/** An invite link that points at a relay: the guest's room token. Null for a direct (home) link. */
export async function relayGuestToken(link: URL, code: string): Promise<{ ws: string; token: string } | null> {
  try {
    const res = await fetch(link.origin + '/api/token?g=' + encodeURIComponent(code), { cache: 'no-store', signal: timeout(5000) })
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null
    return await json<{ ws: string; token: string }>(res)
  } catch (e) {
    if (e instanceof Error && /not on air/i.test(e.message)) throw e
    return null
  }
}

/** Opus settings for a music master: stereo, high rate, no voice tricks (DTX would gate quiet parts). */
export const MUSIC_PUBLISH = { name: 'master', dtx: false, red: false, forceStereo: true, stopMicTrackOnMute: false } as const
