/**
 * Phone as a controller, over the local Wi-Fi.
 *
 * A small web server on this Mac serves the controller page (remote.html) to a phone on the same network,
 * and a WebSocket carries the phone's pads, knobs and faders to the app (and the decks' state back).
 * Only a phone that opened the page with the pairing code (in the QR code) gets in: the code is a random
 * secret kept in the app's data folder, so the phone's bookmark keeps working; "Trocar código" makes a new one.
 *
 * No dependency: the WebSocket protocol (RFC 6455) is handled here, text frames only.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const PORT = 7373
const MAX_CLIENTS = 4
const MAX_FRAME = 8 * 1024
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PAGE = path.join(__dirname, 'remote.html')

/** IPv4 addresses of this Mac on the local network, Wi-Fi / Ethernet first. */
function addresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
      // en0/en1 (Wi-Fi, Ethernet) before bridges, VPNs and virtual machines.
      const rank = /^en\d/.test(name) ? 0 : /^(bridge|utun|vmnet|vboxnet|docker)/.test(name) ? 2 : 1
      out.push({ address: a.address, rank })
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map((a) => a.address)
}

function same(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** One WebSocket frame of text from the server (never masked). */
function frame(text, opcode = 1) {
  const body = Buffer.from(text)
  const n = body.length
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.alloc(4)
  if (n >= 126) {
    if (n > 0xffff) throw new Error('frame too big')
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(n, 2)
  }
  return Buffer.concat([head, body])
}

/**
 * @param {{ dataDir: string, onMessage(msg: object, client: number): void, onClients(n: number): void }} opts
 */
function createRemote({ dataDir, onMessage, onClients }) {
  const keyFile = path.join(dataDir, 'remote.json')
  let code = null
  let server = null
  let port = 0
  const clients = new Map() // id → { socket, alive }
  let nextId = 1
  let pinger = null

  function loadCode() {
    try {
      const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
      if (/^[0-9a-f]{20}$/.test(saved.code)) return saved.code
    } catch {
      /* first time */
    }
    return renewCode()
  }

  function renewCode() {
    code = crypto.randomBytes(10).toString('hex')
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(keyFile, JSON.stringify({ code }), { mode: 0o600 })
    } catch {
      /* kept for this session only */
    }
    return code
  }

  const info = () => {
    const ips = addresses()
    return {
      on: !!server,
      port,
      clients: clients.size,
      urls: server ? ips.map((ip) => 'http://' + ip + ':' + port + '/?k=' + code) : [],
    }
  }

  function drop(id) {
    const c = clients.get(id)
    if (!c) return
    clients.delete(id)
    c.socket.destroy()
    onClients(clients.size)
  }

  function accept(req, socket) {
    const url = new URL(req.url || '/', 'http://x')
    const key = req.headers['sec-websocket-key']
    if (url.pathname !== '/ws' || !same(url.searchParams.get('k'), code) || !key || clients.size >= MAX_CLIENTS) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n',
    )
    socket.setNoDelay(true) // pads and faders: every message at once
    const id = nextId++
    clients.set(id, { socket, alive: true })
    onClients(clients.size)

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
        } else if (len === 127) return drop(id) // far bigger than anything the page sends
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
        if (msg && typeof msg === 'object') onMessage(msg, id)
      }
    })
    socket.on('close', () => drop(id))
    socket.on('error', () => drop(id))
  }

  function start() {
    if (server) return Promise.resolve(info())
    code ??= loadCode()
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://x')
        if (url.pathname !== '/' || !same(url.searchParams.get('k'), code)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('RiddimX: abra pelo QR code em Ajustes › Celular.')
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
          })
          res.end(html)
        })
      })
      s.on('upgrade', accept)
      const listen = (p) => {
        s.once('error', (e) => {
          // The usual port is taken: any free one (the QR code carries it).
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
          resolve(info())
        })
      }
      listen(PORT)
    })
  }

  function stop() {
    clearInterval(pinger)
    for (const id of [...clients.keys()]) drop(id)
    server?.close()
    server = null
    port = 0
    return info()
  }

  return {
    start,
    stop,
    info,
    /** A new pairing code: phones connected now are disconnected and need the new QR code. */
    async renew() {
      const was = !!server
      stop()
      renewCode()
      return was ? start() : info()
    },
    /** Text to every phone (the decks' state, a few times a second). */
    broadcast(text) {
      if (!clients.size) return
      const f = frame(text)
      for (const c of clients.values()) c.socket.write(f)
    },
    /** Text to one phone. */
    send(id, text) {
      clients.get(id)?.socket.write(frame(text))
    },
  }
}

module.exports = { createRemote, addresses }
