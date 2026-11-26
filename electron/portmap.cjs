/**
 * Opens a TCP port on the home router, so the live link works from the internet with nothing
 * but this app: UPnP IGD first (most routers), NAT-PMP / PCP-compatible next (Apple, some others).
 * Also reads the router's internet (WAN) address, which tells whether the line is behind CGNAT.
 *
 * No dependency, no outside service: everything here talks only to the router on the local network.
 */
const dgram = require('node:dgram')
const http = require('node:http')
const os = require('node:os')
const { execFile } = require('node:child_process')

const SSDP = { host: '239.255.255.250', port: 1900 }
const DESCRIPTION = 'RiddimX live'

// ───────────────────────── addresses ─────────────────────────

/** 100.64.0.0/10: the carrier's own NAT (CGNAT). */
const isCgnat = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
/** Private ranges: a second router in front of this one (double NAT). */
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip)

/** The default gateway's address (the router), or null. */
function gateway() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('route', ['print', '0.0.0.0'], { timeout: 3000 }, (err, out) => {
        const m = !err && /0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/.exec(String(out))
        resolve(m ? m[1] : null)
      })
      return
    }
    const [cmd, args, re] =
      process.platform === 'darwin'
        ? ['/sbin/route', ['-n', 'get', 'default'], /gateway:\s*(\d+\.\d+\.\d+\.\d+)/]
        : ['ip', ['route', 'show', 'default'], /default via (\d+\.\d+\.\d+\.\d+)/]
    execFile(cmd, args, { timeout: 3000 }, (_err, out) => {
      const m = re.exec(String(out || ''))
      resolve(m ? m[1] : null)
    })
  })
}

/** This Mac's address on the router's network (same /24 as the gateway when possible). */
function localFor(gw) {
  const all = []
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) all.push(a.address)
  const prefix = gw ? gw.split('.').slice(0, 3).join('.') + '.' : ''
  return all.find((a) => prefix && a.startsWith(prefix)) || all[0] || null
}

// ───────────────────────── UPnP IGD ─────────────────────────

function httpText(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: 4000 }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        text += c
        if (text.length > 512 * 1024) req.destroy()
      })
      res.on('end', () => resolve({ status: res.statusCode, text, local: req.socket?.localAddress }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

/** The routers that answer an SSDP search for an internet gateway: their description URLs. */
function discover(ms = 2500) {
  return new Promise((resolve) => {
    const found = new Set()
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const done = () => {
      try {
        sock.close()
      } catch {
        /* closed */
      }
      resolve([...found])
    }
    sock.on('error', done)
    sock.on('message', (msg) => {
      const loc = /^location:\s*(\S+)/im.exec(msg.toString())
      if (loc && /^http:\/\//i.test(loc[1])) found.add(loc[1])
    })
    sock.bind(0, () => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'urn:schemas-upnp-org:service:WANIPConnection:1']) {
        const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`)
        sock.send(m, SSDP.port, SSDP.host)
      }
    })
    setTimeout(done, ms)
  })
}

/** The WAN connection service in a router's description: { type, control }. */
async function service(location) {
  const { text } = await httpText(location)
  const base = /<URLBase>\s*([^<]+)\s*<\/URLBase>/i.exec(text)?.[1] || location
  const blocks = text.split(/<service>/i).slice(1)
  for (const kind of ['WANIPConnection:2', 'WANIPConnection:1', 'WANPPPConnection:1']) {
    for (const b of blocks) {
      const type = /<serviceType>\s*([^<]+)\s*<\/serviceType>/i.exec(b)?.[1]
      const ctl = /<controlURL>\s*([^<]+)\s*<\/controlURL>/i.exec(b)?.[1]
      if (type && ctl && type.endsWith(kind)) return { type, control: new URL(ctl, base).toString() }
    }
  }
  return null
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

async function soap(svc, action, args) {
  const inner = Object.entries(args)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('')
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">${inner}</u:${action}></s:Body></s:Envelope>`
  const res = await httpText(svc.control, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"` },
    body,
  })
  if (res.status !== 200) {
    const code = /<errorCode>\s*(\d+)/i.exec(res.text)?.[1]
    const e = new Error('UPnP ' + action + ' failed' + (code ? ' (' + code + ')' : ''))
    e.code = code
    throw e
  }
  return res
}

const tag = (text, name) => new RegExp('<' + name + '>\\s*([^<]*)\\s*</' + name + '>', 'i').exec(text)?.[1] ?? ''

async function upnpMap(port) {
  const locations = await discover()
  for (const loc of locations) {
    let svc
    try {
      svc = await service(loc)
    } catch {
      continue
    }
    if (!svc) continue
    const client = (await httpText(loc).catch(() => null))?.local?.replace(/^::ffff:/, '') || localFor(new URL(loc).hostname)
    const args = (lease) => ({
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: 'TCP',
      NewInternalPort: port,
      NewInternalClient: client,
      NewEnabled: 1,
      NewPortMappingDescription: DESCRIPTION,
      NewLeaseDuration: lease,
    })
    try {
      await soap(svc, 'AddPortMapping', args(3600))
    } catch (e) {
      if (e.code !== '725') throw e // 725: this router only takes permanent mappings
      await soap(svc, 'AddPortMapping', args(0))
    }
    let wan = ''
    try {
      wan = tag((await soap(svc, 'GetExternalIPAddress', {})).text, 'NewExternalIPAddress')
    } catch {
      /* unknown */
    }
    return {
      method: 'UPnP',
      port,
      wan,
      router: new URL(loc).hostname,
      remove: () => soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' }).catch(() => undefined),
      renew: () => soap(svc, 'AddPortMapping', args(3600)).catch(() => soap(svc, 'AddPortMapping', args(0))).catch(() => undefined),
    }
  }
  return null
}

// ───────────────────────── NAT-PMP ─────────────────────────

function pmp(gw, request, expectOp, ms = 1500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let tries = 0
    let timer = 0
    const done = (v) => {
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        /* closed */
      }
      resolve(v)
    }
    sock.on('error', () => done(null))
    sock.on('message', (msg) => {
      if (msg.length >= 8 && msg[0] === 0 && msg[1] === expectOp) done(msg)
    })
    const send = () => {
      if (tries++ >= 3) return done(null)
      sock.send(request, 5351, gw)
      timer = setTimeout(send, ms / 3)
    }
    send()
  })
}

async function pmpMap(gw, port, lifetime = 3600) {
  if (!gw) return null
  const addr = await pmp(gw, Buffer.from([0, 0]), 128)
  if (!addr || addr.readUInt16BE(2) !== 0) return null
  const wan = [8, 9, 10, 11].map((i) => addr[i]).join('.')
  const req = (life) => {
    const b = Buffer.alloc(12)
    b[1] = 2 // map TCP
    b.writeUInt16BE(port, 4)
    b.writeUInt16BE(port, 6)
    b.writeUInt32BE(life, 8)
    return b
  }
  const res = await pmp(gw, req(lifetime), 130)
  if (!res || res.readUInt16BE(2) !== 0) return null
  const external = res.readUInt16BE(10)
  return {
    method: 'NAT-PMP',
    port: external,
    wan,
    router: gw,
    remove: () => pmp(gw, req(0), 130),
    renew: () => pmp(gw, req(lifetime), 130),
  }
}

// ───────────────────────── public address (STUN) ─────────────────────────

/**
 * This line's public IPv4 address as the internet sees it: one STUN binding request (RFC 5389) to a
 * public STUN server (no account; it only echoes our address back). Null when none answers.
 */
function publicIp(servers = [['stun.l.google.com', 19302], ['stun.cloudflare.com', 3478]], ms = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const tx = require('node:crypto').randomBytes(12)
    const req = Buffer.alloc(20)
    req.writeUInt16BE(0x0001, 0)
    req.writeUInt32BE(0x2112a442, 4)
    tx.copy(req, 8)
    const done = (v) => {
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        /* closed */
      }
      resolve(v)
    }
    const timer = setTimeout(() => done(null), ms)
    sock.on('error', () => done(null))
    sock.on('message', (msg) => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || !msg.subarray(8, 20).equals(tx)) return
      for (let at = 20; at + 4 <= msg.length; ) {
        const type = msg.readUInt16BE(at)
        const len = msg.readUInt16BE(at + 2)
        const v = msg.subarray(at + 4, at + 4 + len)
        if ((type === 0x0020 || type === 0x0001) && v[1] === 1 && len >= 8) {
          const ip = [...v.subarray(4, 8)].map((b, i) => (type === 0x0020 ? b ^ [0x21, 0x12, 0xa4, 0x42][i] : b))
          return done(ip.join('.'))
        }
        at += 4 + len + ((4 - (len % 4)) % 4)
      }
    })
    sock.bind(0, () => {
      for (const [host, port] of servers) sock.send(req, port, host)
    })
  })
}

// ───────────────────────── together ─────────────────────────

/**
 * Open `port` (TCP) on the router. Resolves to
 * { ok, method, port, wan, router, nat: 'public' | 'cgnat' | 'double' | 'unknown', error, stop() }.
 * The mapping is renewed every 20 minutes until stop().
 */
async function openPort(port) {
  const gw = await gateway()
  const seen = publicIp() // in parallel with the router's answer
  let map = null
  let error = ''
  try {
    map = await upnpMap(port)
  } catch (e) {
    error = String(e.message || e)
  }
  if (!map) {
    map = await pmpMap(gw, port).catch(() => null)
    if (!map && !error) error = 'The router did not answer UPnP or NAT-PMP (turned off, or not supported).'
  }
  const pub = (await seen) || ''
  const wan = map?.wan && map.wan !== '0.0.0.0' ? map.wan : ''
  // What stands between this Mac and the internet:
  //   public: the router itself holds the public address, so the opened port is reachable;
  //   double: the router's internet side is a private address (another router / the ISP modem in front);
  //   cgnat:  the carrier shares one public address between many homes (100.64/10, or the router's
  //           public address differs from the one the internet sees).
  let nat = 'unknown'
  if (wan && isCgnat(wan)) nat = 'cgnat'
  else if (wan && isPrivate(wan)) nat = 'double'
  else if (wan && pub && wan !== pub) nat = 'cgnat'
  else if (wan && (!pub || wan === pub)) nat = 'public'
  else if (map && !wan && pub) nat = 'double' // the router hides a private internet side (miniupnpd does)
  let timer = null
  if (map) timer = setInterval(() => void map.renew(), 20 * 60 * 1000)
  return {
    ok: !!map,
    method: map?.method || '',
    port: map?.port || port,
    wan,
    publicIp: pub,
    router: map?.router || gw || '',
    local: localFor(gw),
    nat,
    error: map ? '' : error,
    async stop() {
      clearInterval(timer)
      await map?.remove()
    },
  }
}

module.exports = { openPort, publicIp, isCgnat, isPrivate, gateway }
