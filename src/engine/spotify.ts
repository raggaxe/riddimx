/* eslint-disable @typescript-eslint/no-explicit-any */
import { Store } from '../store'
import { desktop } from './ytremote'

const LS = { client: 'vx_sp_client', token: 'vx_sp_token', verifier: 'vx_sp_verifier' }
const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state'

interface Token {
  access_token: string
  refresh_token: string
  expires_at: number
}

export interface SpotifyState {
  clientId: string
  loggedIn: boolean
  ready: boolean
  error: string | null
}

/** A deck currently holding the (single) Spotify playback stream. */
export interface SpotifyOwner {
  onSpotifyState(state: any): void
  spotifyReleased(): void
}

function readToken(): Token | null {
  try {
    return JSON.parse(localStorage.getItem(LS.token) || 'null')
  } catch {
    return null
  }
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  bytes.forEach((b) => (s += String.fromCharCode(b)))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function parseSpotifyTrack(input: string): string | null {
  const m =
    input.match(/spotify:track:([A-Za-z0-9]{22})/) ||
    input.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/)
  return m ? m[1] : null
}

/** What went wrong at Spotify's login, said so the DJ knows what to fix. */
function loginError(code: string, redirect: string): string {
  if (code === 'invalid_client') return "Spotify doesn't know this Client ID. Copy it again from your app's page at developer.spotify.com."
  if (code === 'invalid_redirect')
    return 'Spotify refused the return address. In your app at developer.spotify.com, add this Redirect URI exactly: ' + redirect
  if (code === 'access_denied') return 'Spotify login cancelled.'
  if (code.startsWith('network')) return "Couldn't reach Spotify. Check the internet connection and try again."
  return 'Spotify login refused (' + code + ').'
}

class SpotifyService extends Store<SpotifyState> {
  player: any = null
  deviceId = ''
  owner: SpotifyOwner | null = null
  private token: Token | null = readToken()
  private playerPromise: Promise<void> | null = null

  constructor() {
    super({
      clientId: localStorage.getItem(LS.client) || '',
      loggedIn: !!readToken(),
      ready: false,
      error: null,
    })
  }

  get redirectUri(): string {
    return location.origin + '/'
  }

  setClientId(id: string): void {
    const clientId = id.trim()
    localStorage.setItem(LS.client, clientId)
    this.set({ clientId })
  }

  /** Authorization Code + PKCE: no client secret, runs fully in the browser. */
  async login(): Promise<void> {
    const { clientId } = this.state
    this.set({ error: null }) // the same mistake twice still says so twice
    if (!clientId) {
      this.set({ error: 'Paste the Client ID of the app you created at developer.spotify.com first.' })
      return
    }
    if (!/^[0-9a-f]{32}$/i.test(clientId)) {
      this.set({
        error: "That isn't a Client ID: it is 32 letters and numbers, on your app's page at developer.spotify.com (Settings › Basic Information). Not the Client Secret.",
      })
      return
    }
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)))
    localStorage.setItem(LS.verifier, verifier)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: base64url(new Uint8Array(digest)),
      scope: SCOPES,
    })
    const url = 'https://accounts.spotify.com/authorize?' + params.toString()
    if (!desktop?.spotifyAuth) {
      location.href = url // browser: back to this page with ?code=
      return
    }
    // Desktop app: in its own window, so a wrong Client ID never replaces the app.
    const answer = await desktop.spotifyAuth(url, this.redirectUri)
    if (answer.code) await this.finishLogin(answer.code)
    else if (answer.error !== 'closed') this.set({ error: loginError(answer.error || 'refused', this.redirectUri) })
  }

  /** Call once at startup: completes the login if we were redirected back with ?code=. */
  async handleRedirect(): Promise<void> {
    const query = new URLSearchParams(location.search)
    const code = query.get('code')
    const error = query.get('error')
    if (!code && !error) return
    history.replaceState({}, '', location.pathname)
    if (error || !code) {
      this.set({ error: loginError(error || 'refused', this.redirectUri) })
      return
    }
    await this.finishLogin(code)
  }

  private async finishLogin(code: string): Promise<void> {
    try {
      await this.requestToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.state.clientId,
        code_verifier: localStorage.getItem(LS.verifier) || '',
      })
      this.set({ loggedIn: true, error: null })
    } catch (e) {
      this.set({ error: (e as Error).message })
    }
  }

  logout(): void {
    localStorage.removeItem(LS.token)
    this.token = null
    this.player?.disconnect()
    this.player = null
    this.playerPromise = null
    this.deviceId = ''
    this.owner?.spotifyReleased()
    this.owner = null
    this.set({ loggedIn: false, ready: false })
  }

  private async requestToken(form: Record<string, string>): Promise<void> {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error('Spotify auth: ' + (json.error_description || json.error || res.status))
    this.token = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || this.token?.refresh_token || '',
      expires_at: Date.now() + json.expires_in * 1000,
    }
    localStorage.setItem(LS.token, JSON.stringify(this.token))
  }

  async getToken(): Promise<string> {
    if (!this.token) throw new Error('Connect the Spotify account first (Settings › Accounts)')
    if (Date.now() > this.token.expires_at - 60_000) {
      await this.requestToken({
        grant_type: 'refresh_token',
        refresh_token: this.token.refresh_token,
        client_id: this.state.clientId,
      })
    }
    return this.token!.access_token
  }

  async api(method: string, path: string, body?: unknown): Promise<any> {
    const call = async (): Promise<Response> =>
      fetch('https://api.spotify.com/v1' + path, {
        method,
        headers: { Authorization: 'Bearer ' + (await this.getToken()), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    let res = await call()
    if (res.status === 401 && this.token?.refresh_token) {
      // A token Spotify no longer takes (e.g. issued just as the app was set up): a fresh one, once.
      await this.requestToken({ grant_type: 'refresh_token', refresh_token: this.token.refresh_token, client_id: this.state.clientId })
      res = await call()
    } else if (res.status === 429) {
      const wait = Math.min(5, Number(res.headers.get('Retry-After')) || 1)
      await new Promise((r) => window.setTimeout(r, wait * 1000))
      res = await call()
    }
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* some endpoints answer with plain text */
    }
    if (!res.ok) throw new Error('Spotify: ' + (json?.error?.message || res.status))
    return json
  }

  /** Creates the in-browser Spotify Connect device (Web Playback SDK, Premium only). */
  ensurePlayer(): Promise<void> {
    if (!this.playerPromise) {
      this.playerPromise = new Promise<void>((resolve, reject) => {
        const w = window as any
        // No answer at all (no "ready", no error) must not leave the deck loading forever.
        const timer = window.setTimeout(
          () => fail("Spotify's player didn't start. Check the internet connection and that the account has Premium, then load the track again."),
          20000,
        )
        const fail = (message: string) => {
          window.clearTimeout(timer)
          this.player?.disconnect?.()
          this.player = null
          this.playerPromise = null
          this.set({ ready: false, error: message })
          reject(new Error(message))
        }
        const create = () => {
          const player = new w.Spotify.Player({
            name: 'RiddimX',
            volume: 0.8,
            getOAuthToken: (cb: (t: string) => void) => {
              this.getToken().then(cb, () => undefined)
            },
          })
          player.addListener('ready', ({ device_id }: any) => {
            window.clearTimeout(timer)
            this.deviceId = device_id
            this.set({ ready: true, error: null })
            resolve()
          })
          player.addListener('not_ready', () => this.set({ ready: false }))
          player.addListener('initialization_error', (e: any) => fail('Spotify: ' + e.message))
          player.addListener('authentication_error', (e: any) => fail('Spotify auth: ' + e.message))
          player.addListener('account_error', () => fail('Spotify only plays on the decks with a Premium account.'))
          player.addListener('playback_error', (e: any) => this.set({ error: "Spotify couldn't play this track: " + (e?.message || 'unknown error') }))
          player.addListener('autoplay_failed', () => this.set({ error: 'Spotify needs a click to start: press PLAY on the deck.' }))
          player.addListener('player_state_changed', (s: any) => this.owner?.onSpotifyState(s))
          this.player = player
          void player.connect()
        }
        if (w.Spotify?.Player) return create()
        w.onSpotifyWebPlaybackSDKReady = create
        const script = document.createElement('script')
        script.src = 'https://sdk.scdn.co/spotify-player.js'
        script.onerror = () => fail('Couldn\'t load the Spotify SDK')
        document.head.appendChild(script)
      })
    }
    return this.playerPromise
  }
}

export const spotify = new SpotifyService()
