/**
 * GO LIVE: a link anyone can open to hear the master mix, and an invite for a guest co-DJ.
 *
 * This server only carries the calls' set-up messages (WebRTC signalling) and the listener page
 * (listen.html); the sound itself goes straight from the app to each listener as a WebRTC call.
 * On GO LIVE the app asks the home router to open the server's port (UPnP / NAT-PMP, portmap.cjs)
 * and builds the link from the line's public address: no account, no outside relay. When the router
 * cannot (double NAT, carrier NAT, UPnP off), the app says why and what to forward by hand.
 * Plain http is enough: a page only receiving a WebRTC call needs no secure context.
 *
 * Two secrets, both new on every GO LIVE: `k` lets a page listen, `g` lets one guest app in to
 * control a deck. Without the right one, every request gets a 403.
 *
 * No dependency: the WebSocket protocol (RFC 6455) is handled here, text frames only.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { addresses, localName } = require('./remote.cjs')
const { openPort } = require('./portmap.cjs')

const PORT = 7380
const MAX_LISTENERS = 40 // hard ceiling; the app turns newcomers away sooner when the upload is full (live.ts)
const MAX_GUESTS = 1
const MAX_FRAME = 64 * 1024 // a call description with all its network candidates is a few KB
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PAGE = path.join(__dirname, 'listen.html')

function same(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** One WebSocket frame from the server (never masked). */
function frame(text, opcode = 1) {
  const body = Buffer.from(text)
  const n = body.length
  let head
  if (n < 126) head = Buffer.from([0x80 | opcode, n])
  else if (n <= 0xffff) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(n, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, body])
}

/**
 * @param {{ onSignal(ev: { t: 'join' | 'leave' | 'msg', id: number, role: 'listen' | 'guest', msg?: object }): void }} opts
 */
function createLive({ onSignal }) {
  let server = null
  let port = 0
  let mapping = null // the router's port mapping (portmap.cjs openPort result)
  let reach = 'off' // 'checking' while asking the router, then its answer
  let listenCode = ''
  let guestCode = ''
  const clients = new Map() // id → { socket, role, alive }
  let nextId = 1
  let pinger = null

  const count = (role) => [...clients.values()].filter((c) => c.role === role).length

  const info = () => {
    const lan = addresses()[0]
    const q = (base) => ({
      listen: base ? base + '/?k=' + listenCode : '',
      guest: base ? base + '/?g=' + guestCode : '',
    })
    return {
      on: !!server,
      port,
      public: q(mapping?.publicIp ? 'http://' + mapping.publicIp + ':' + (mapping.port || port) : ''),
      lan: q(server && lan ? 'http://' + (localName() || lan) + ':' + port : ''),
      lanIp: q(server && lan ? 'http://' + lan + ':' + port : ''),
      local: q(server ? 'http://127.0.0.1:' + port : ''),
      // How the internet reaches this server: 'open' (port opened, router holds the public address),
      // 'double' / 'cgnat' / 'unknown' (opened here, but something in front may block), 'closed' (router said no).
      reach,
      nat: mapping?.nat ?? '',
      method: mapping?.method ?? '',
      router: mapping?.router ?? '',
      localIp: mapping?.local ?? addresses()[0] ?? '',
      reachError: mapping?.error ?? '',
      listeners: count('listen'),
      guests: count('guest'),
    }
  }

  function drop(id) {
    const c = clients.get(id)
    if (!c) return
    clients.delete(id)
    c.socket.destroy()
    onSignal({ t: 'leave', id, role: c.role })
  }

  function accept(req, socket) {
    const url = new URL(req.url || '/', 'http://x')
    const key = req.headers['sec-websocket-key']
    const role = same(url.searchParams.get('k'), listenCode) ? 'listen' : same(url.searchParams.get('g'), guestCode) ? 'guest' : null
    const full = role === 'listen' ? count('listen') >= MAX_LISTENERS : role === 'guest' && count('guest') >= MAX_GUESTS
    if (url.pathname !== '/ws' || !role || !key || full) {
      socket.end(full ? 'HTTP/1.1 503 Service Unavailable\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n')
    socket.setNoDelay(true)
    const id = nextId++
    clients.set(id, { socket, role, alive: true })
    onSignal({ t: 'join', id, role })

    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f
        const masked = buf[1] & 0x80
        let len = buf[1] & 0x7f
        let at = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          at = 4
        } else if (len === 127) return drop(id)
        if (!masked || len > MAX_FRAME) return drop(id)
        if (buf.length < at + 4 + len) return
        const mask = buf.subarray(at, at + 4)
        const data = Buffer.from(buf.subarray(at + 4, at + 4 + len))
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
        buf = buf.subarray(at + 4 + len)
        const c = clients.get(id)
        if (!c) return
        c.alive = true
        if (op === 0x8) return drop(id)
        if (op === 0x9) socket.write(frame(data.toString(), 0xa))
        if (op !== 0x1) continue
        let msg
        try {
          msg = JSON.parse(data.toString('utf8'))
        } catch {
          continue
        }
        if (msg && typeof msg === 'object') onSignal({ t: 'msg', id, role, msg })
      }
    })
    socket.on('close', () => drop(id))
    socket.on('error', () => drop(id))
  }

  /** The listener page, for a link with the listen code; nothing else. */
  function serve(req, res) {
    const url = new URL(req.url || '/', 'http://x')
    const ok = url.pathname === '/' && (same(url.searchParams.get('k'), listenCode) || same(url.searchParams.get('g'), guestCode))
    if (!ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('RiddimX: this live link is not on air (the DJ stopped, or the link is from an older set).')
    }
    fs.readFile(PAGE, (err, html) => {
      if (err) {
        res.writeHead(500)
        return res.end()
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      })
      res.end(html)
    })
  }

  /** Ask the router to open the port; the link's public address comes with the answer. */
  async function openRouter() {
    reach = 'checking'
    const m = await openPort(port).catch((e) => ({ ok: false, nat: 'unknown', error: String(e.message || e), publicIp: '', stop: async () => undefined }))
    if (!server) {
      await m.stop()
      return
    }
    mapping = m
    reach = !m.ok ? 'closed' : m.nat === 'public' ? 'open' : m.nat
  }

  function start() {
    if (server) return Promise.resolve(info())
    listenCode = crypto.randomBytes(9).toString('hex')
    guestCode = crypto.randomBytes(9).toString('hex')
    return new Promise((resolve) => {
      const s = http.createServer(serve)
      s.on('upgrade', accept)
      const listen = (p) => {
        s.once('error', (e) => {
          if (e.code === 'EADDRINUSE' && p === PORT) return listen(0)
          resolve({ ...info(), error: String(e.message || e) })
        })
        s.listen(p, '0.0.0.0', () => {
          server = s
          port = s.address().port
          pinger = setInterval(() => {
            for (const [id, c] of clients) {
              if (!c.alive) drop(id)
              else {
                c.alive = false
                c.socket.write(frame('', 0x9))
              }
            }
          }, 10000)
          void openRouter().then(() => resolve(info()))
        })
      }
      listen(PORT)
    })
  }

  function stop() {
    clearInterval(pinger)
    for (const id of [...clients.keys()]) drop(id)
    const m = mapping
    mapping = null
    reach = 'off'
    void m?.stop() // close the router's port again
    server?.close()
    server?.closeAllConnections?.()
    server = null
    port = 0
    listenCode = ''
    guestCode = ''
    return info()
  }

  return {
    start,
    stop,
    info,
    send(id, text) {
      const c = clients.get(id)
      if (c && Buffer.byteLength(text) <= MAX_FRAME) c.socket.write(frame(text))
    },
    kick: drop,
    /** The app's window started again (PANIC restart): every page reconnects and gets a new call. */
    dropAll() {
      for (const id of [...clients.keys()]) drop(id)
      return info()
    },
  }
}

module.exports = { createLive }
