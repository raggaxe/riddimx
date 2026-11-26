/**
 * RiddimX relay: the small piece next to LiveKit on the DJ's own server.
 *
 * When the DJ's home network cannot be reached from the internet (double NAT, CGNAT), the app
 * connects OUT to this server instead: it publishes the master into a LiveKit room, and listeners
 * and the guest co-DJ join that room. This endpoint only hands out room tokens and serves the
 * listener page; LiveKit (SFU + TURN) carries the sound, so listeners no longer cost the DJ's upload.
 *
 *   POST /api/session         (Authorization: Bearer RELAY_KEY) → a new set: host token + links
 *   PUT    /api/session/:room (Authorization: Bearer <hostSecret>) → still on air (every minute)
 *   DELETE /api/session/:room (Authorization: Bearer <hostSecret>) → the set ends
 *   GET  /api/token?k=…       → a listen-only token     GET /api/token?g=… → the guest's token
 *   GET  /?k=…                → the listener page        GET /livekit-client.umd.js
 *
 * Phone controller from anywhere (Settings › Phone): the app keeps a room for its phones.
 *   POST /api/remote  { code } (Authorization: Bearer RELAY_KEY) → the app's ("desk") token + phone link
 *   PUT / DELETE /api/remote/:room (Authorization: Bearer <code>) → still on / off
 *   GET  /api/token?r=<code>  → a phone's token (data + its microphone)
 *   GET  /r/?k=<code>         → the controller page (remote.html + phone-bridge.js)
 *
 * No dependency but livekit-client (only served to the page). Tokens are signed here (HS256).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const env = (k, d) => process.env[k] ?? d
const PORT = Number(env('PORT', 8080))
const API_KEY = env('LIVEKIT_API_KEY', 'devkey')
const API_SECRET = env('LIVEKIT_API_SECRET', 'secret')
const RELAY_KEY = env('RELAY_KEY', '')
const PUBLIC_URL = env('PUBLIC_URL', 'http://127.0.0.1:' + PORT).replace(/\/$/, '')
const LIVEKIT_WS = env('LIVEKIT_WS', PUBLIC_URL.replace(/^http/, 'ws'))
const MAX_SETS = Number(env('MAX_SETS', 20))
const SET_HOURS = Number(env('SET_HOURS', 12))
/** A set whose app stopped saying "still on air" (crashed, closed, offline) is dropped after this. */
const SILENT_MS = 3 * 60 * 1000

if (!RELAY_KEY) console.warn('RELAY_KEY is empty: anyone could open sets on this server. Set it in .env.')

const PAGE = path.join(here, 'listen.html')
const PHONE_PAGE = path.join(here, 'remote.html') // a copy of electron/remote.html (npm run relay:sync)
const BRIDGE = path.join(here, 'phone-bridge.js')
const MAX_REMOTES = Number(env('MAX_REMOTES', 50))
const UMD = (() => {
  for (const p of [path.join(here, 'node_modules/livekit-client/dist/livekit-client.umd.js'), path.join(here, '../../node_modules/livekit-client/dist/livekit-client.umd.js')])
    if (fs.existsSync(p)) return p
  return null
})()

/** room → { listen, guest, hostSecret, until, seen } */
const sets = new Map()
/** room → { code, seen }: one per app with the phone controller on */
const remotes = new Map()
const remoteRoom = (code) => 'rm-' + crypto.createHash('sha256').update('riddimx-remote:' + code).digest('hex').slice(0, 20)
function findRemote(code) {
  const now = Date.now()
  for (const [room, r] of remotes) if (now - r.seen > SILENT_MS) remotes.delete(room)
  const room = code && /^[0-9a-f]{16,64}$/.test(code) ? remoteRoom(code) : null
  const r = room && remotes.get(room)
  return r && same(r.code, code) ? room : null
}
const readBody = (req) =>
  new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 4096) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'))
      } catch {
        resolve({})
      }
    })
  })
const rand = (n) => crypto.randomBytes(n).toString('hex')

function same(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

/** A LiveKit access token (JWT, HS256). */
function token(identity, room, grants, hours = SET_HOURS) {
  const now = Math.floor(Date.now() / 1000)
  const body = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ iss: API_KEY, sub: identity, nbf: now - 10, exp: now + hours * 3600, name: identity, video: { room, roomJoin: true, ...grants } })
  return body + '.' + crypto.createHmac('sha256', API_SECRET).update(body).digest('base64url')
}

function findSet(kind, code) {
  const now = Date.now()
  for (const [room, s] of sets) {
    if (s.until < now || now - s.seen > SILENT_MS) {
      sets.delete(room)
      continue
    }
    if (code && same(s[kind], code)) return room
  }
  return null
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', // the app (http://127.0.0.1:5173) and the guest's app call the API
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain')

  if (url.pathname === '/api/session' && req.method === 'POST') {
    if (RELAY_KEY && !same(auth, RELAY_KEY)) return send(res, 403, { error: 'wrong key' })
    findSet('', '') // drops expired sets
    if (sets.size >= MAX_SETS) return send(res, 503, { error: 'server full' })
    const room = 'set-' + rand(6)
    const s = { listen: rand(9), guest: rand(9), hostSecret: rand(16), until: Date.now() + SET_HOURS * 3600e3, seen: Date.now() }
    sets.set(room, s)
    return send(res, 200, {
      ws: LIVEKIT_WS,
      room,
      hostSecret: s.hostSecret,
      token: token('host', room, { canPublish: true, canSubscribe: true, canPublishData: true }),
      listen: PUBLIC_URL + '/?k=' + s.listen,
      guest: PUBLIC_URL + '/?g=' + s.guest,
    })
  }
  const one = /^\/api\/session\/(set-[0-9a-f]+)$/.exec(url.pathname)
  if (one && (req.method === 'DELETE' || req.method === 'PUT')) {
    findSet('', '') // drops silent sets first
    const s = sets.get(one[1])
    if (!s || !same(auth, s.hostSecret)) return send(res, 403, { error: 'This set is over.' })
    if (req.method === 'PUT') s.seen = Date.now()
    else sets.delete(one[1])
    return send(res, 200, { ok: true })
  }
  if (url.pathname === '/api/remote' && req.method === 'POST') {
    if (RELAY_KEY && !same(auth, RELAY_KEY)) return send(res, 403, { error: 'wrong key' })
    const { code } = await readBody(req)
    if (typeof code !== 'string' || !/^[0-9a-f]{16,64}$/.test(code)) return send(res, 400, { error: 'bad code' })
    findRemote('') // drops silent ones
    const room = remoteRoom(code)
    if (!remotes.has(room) && remotes.size >= MAX_REMOTES) return send(res, 503, { error: 'server full' })
    remotes.set(room, { code, seen: Date.now() })
    return send(res, 200, {
      ws: LIVEKIT_WS,
      room,
      token: token('desk', room, { canPublish: false, canSubscribe: true, canPublishData: true }),
      url: PUBLIC_URL + '/r/?k=' + code,
    })
  }
  const rm = /^\/api\/remote\/(rm-[0-9a-f]+)$/.exec(url.pathname)
  if (rm && (req.method === 'PUT' || req.method === 'DELETE')) {
    const r = remotes.get(rm[1])
    if (!r || !same(auth, r.code)) return send(res, 403, { error: 'This phone link is off.' })
    if (req.method === 'PUT') r.seen = Date.now()
    else remotes.delete(rm[1])
    return send(res, 200, { ok: true })
  }
  if (url.pathname === '/api/token' && req.method === 'GET' && url.searchParams.get('r')) {
    const room = findRemote(url.searchParams.get('r'))
    if (!room) return send(res, 404, { error: 'RiddimX is not open, or the phone is off in its Settings.' })
    // A phone: sends controls, gets the decks' state, and may send its microphone (nothing else).
    return send(res, 200, {
      ws: LIVEKIT_WS,
      token: token('phone-' + rand(4), room, { canPublish: true, canPublishSources: ['microphone'], canSubscribe: false, canPublishData: true }, 24),
    })
  }
  if (url.pathname === '/r/' && url.searchParams.get('k')) {
    return fs.readFile(PHONE_PAGE, 'utf8', (err, html) => {
      if (err) return send(res, 500, '', 'text/plain')
      // The same controller page as on the Wi-Fi, talking through LiveKit instead of a local socket.
      const page = html.replace('<script>', '<script src="/livekit-client.umd.js"></script><script src="/phone-bridge.js"></script><script>')
      send(res, 200, page, 'text/html; charset=utf-8')
    })
  }
  if (url.pathname === '/phone-bridge.js') {
    return fs.readFile(BRIDGE, (err, js) => (err ? send(res, 500, '', 'text/plain') : send(res, 200, js, 'text/javascript; charset=utf-8')))
  }
  if (url.pathname === '/api/token' && req.method === 'GET') {
    const k = url.searchParams.get('k')
    const g = url.searchParams.get('g')
    const room = k ? findSet('listen', k) : g ? findSet('guest', g) : null
    if (!room) return send(res, 404, { error: 'This live set is not on air.' })
    if (k) return send(res, 200, { ws: LIVEKIT_WS, token: token('l-' + rand(4), room, { canPublish: false, canSubscribe: true, canPublishData: false }) })
    // One guest: always the same identity, so a second one replaces the first (LiveKit drops the older).
    return send(res, 200, { ws: LIVEKIT_WS, token: token('guest', room, { canPublish: false, canSubscribe: true, canPublishData: true }) })
  }
  if (url.pathname === '/livekit-client.umd.js' && UMD) {
    return fs.readFile(UMD, (err, js) => (err ? send(res, 500, '', 'text/plain') : send(res, 200, js, 'text/javascript; charset=utf-8')))
  }
  if (url.pathname === '/' && (url.searchParams.get('k') || url.searchParams.get('g'))) {
    return fs.readFile(PAGE, (err, html) => (err ? send(res, 500, '', 'text/plain') : send(res, 200, html, 'text/html; charset=utf-8')))
  }
  if (url.pathname === '/health') return send(res, 200, { ok: true, sets: sets.size })
  send(res, 404, 'RiddimX relay', 'text/plain; charset=utf-8')
})

server.listen(PORT, env('HOST', '127.0.0.1'), () => console.log('RiddimX relay on :' + PORT + ' · public ' + PUBLIC_URL + ' · LiveKit ' + LIVEKIT_WS))
