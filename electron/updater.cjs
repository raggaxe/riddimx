/**
 * Updates of the packaged app, from the project's GitHub releases.
 *
 * On start (and every few hours) the latest release is looked up. When it is newer than this app,
 * the page is told, the zip for this Mac (RiddimX-darwin-<arch>.zip) is downloaded in the background,
 * checked against its published SHA-256 (RiddimX-darwin-<arch>.zip.sha256) and unpacked. The new app
 * replaces this one when the DJ asks ("Reiniciar e atualizar") or the next time the app quits.
 *
 * Nothing is installed without a matching SHA-256, and files only come from GitHub over HTTPS.
 */
const { app, net } = require('electron')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = 'raggaxe/riddimx'
const LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest'
const EVERY = 6 * 60 * 60 * 1000 // look again every 6 hours while the app stays open
const TRUSTED = /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//

/** "v1.2.3" → [1, 2, 3]; anything else → null. */
function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim())
  return m ? m.slice(1).map(Number) : null
}

function newer(a, b) {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** The .app bundle this process runs from (…/RiddimX.app/Contents/MacOS/RiddimX), or null. */
function bundlePath() {
  const p = path.resolve(process.execPath, '..', '..', '..')
  return p.endsWith('.app') ? p : null
}

function setupUpdater(win) {
  const dir = path.join(app.getPath('userData'), 'updates')
  const asset = 'RiddimX-' + process.platform + '-' + process.arch + '.zip'
  // What the page shows: idle · checking · none · available · downloading · ready · error · dev
  let state = { status: app.isPackaged ? 'idle' : 'dev', current: app.getVersion() }
  let ready = null // { version, app } once a new version is unpacked and checked
  let busy = false
  let installOnQuit = false

  const send = (change) => {
    state = { ...state, ...change }
    if (!win.isDestroyed()) win.webContents.send('vx:update', state)
  }

  const fetchJson = async (url) => {
    const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RiddimX-Updater' } })
    if (res.status === 404) return null // no release yet (or the repository is private)
    if (!res.ok) throw new Error('GitHub respondeu ' + res.status)
    return res.json()
  }

  async function download(url, file, size, progress) {
    if (!TRUSTED.test(url)) throw new Error('untrusted download address')
    const res = await net.fetch(url, { headers: { 'User-Agent': 'RiddimX-Updater' } })
    if (!res.ok || !res.body) throw new Error('download falhou (' + res.status + ')')
    if (res.url && !TRUSTED.test(res.url)) throw new Error('download redirected outside GitHub')
    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(file)
    let got = 0
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk)
        hash.update(buf)
        got += buf.length
        if (!out.write(buf)) await once(out, 'drain')
        if (size) progress?.(Math.min(1, got / size))
      }
      out.end()
      await once(out, 'finish')
    } catch (e) {
      out.destroy()
      throw e
    }
    if (size && got !== size) throw new Error('download size does not match')
    return hash.digest('hex')
  }

  async function check(manual = false) {
    if (!app.isPackaged) return send({ status: 'dev' })
    if (busy || ready) return
    busy = true
    try {
      send({ status: 'checking' })
      const rel = await fetchJson(LATEST)
      const version = rel?.tag_name
      if (!rel || rel.draft || rel.prerelease || !newer(version, app.getVersion())) {
        send({ status: 'none', checkedAt: Date.now(), error: rel ? undefined : manual ? 'no version published' : undefined })
        return
      }
      const zip = rel.assets?.find((a) => a.name === asset)
      const sum = rel.assets?.find((a) => a.name === asset + '.sha256')
      const info = { version: String(version).replace(/^v/, ''), notes: String(rel.body || '').slice(0, 2000), url: rel.html_url }
      if (!zip || !sum) return send({ status: 'available', ...info, error: 'this version has no file for this computer' })
      // Windows: the new version is announced with its page; the DJ downloads it (no swap-in-place yet).
      if (process.platform !== 'darwin') return send({ status: 'available', ...info })
      send({ status: 'downloading', ...info, progress: 0 })

      await fs.promises.rm(dir, { recursive: true, force: true })
      await fs.promises.mkdir(dir, { recursive: true })
      const sumFile = path.join(dir, asset + '.sha256')
      await download(sum.browser_download_url, sumFile, 0)
      const expected = (await fs.promises.readFile(sumFile, 'utf8')).trim().split(/\s+/)[0].toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('published SHA-256 is invalid')
      const zipFile = path.join(dir, asset)
      const got = await download(zip.browser_download_url, zipFile, zip.size, (p) => send({ progress: p }))
      if (got !== expected) throw new Error('the downloaded file does not match its SHA-256')

      const out = path.join(dir, 'app')
      await new Promise((resolve, reject) =>
        execFile('/usr/bin/ditto', ['-x', '-k', zipFile, out], (err) => (err ? reject(err) : resolve())),
      )
      const bundle = path.join(out, 'RiddimX.app')
      if (!fs.existsSync(path.join(bundle, 'Contents', 'MacOS'))) throw new Error('update package is incomplete')
      ready = { version: info.version, app: bundle }
      installOnQuit = true
      send({ status: 'ready', ...info, progress: 1 })
    } catch (e) {
      send({ status: 'error', error: String(e?.message || e) })
    } finally {
      busy = false
    }
  }

  /** Swaps the app bundle once this process has quit, then opens the new one. */
  function install(relaunch) {
    const target = bundlePath()
    if (!ready || !target) return false
    const script = [
      'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
      'rm -rf "$OLD.old" && mv "$OLD" "$OLD.old" && mv "$NEW" "$OLD" && rm -rf "$OLD.old" || { [ -d "$OLD.old" ] && [ ! -d "$OLD" ] && mv "$OLD.old" "$OLD"; }',
      '/usr/bin/xattr -dr com.apple.quarantine "$OLD" 2>/dev/null',
      '[ "$OPEN" = 1 ] && /usr/bin/open "$OLD"',
    ].join('\n')
    const child = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: { PID: String(process.pid), OLD: target, NEW: ready.app, OPEN: relaunch ? '1' : '0', PATH: '/usr/bin:/bin' },
    })
    child.unref()
    installOnQuit = false
    return true
  }

  return {
    state: () => state,
    check,
    /** "Reiniciar e atualizar": quit now; the new version opens by itself. */
    installNow() {
      if (install(true)) app.quit()
    },
    start() {
      if (!app.isPackaged) return send({ status: 'dev' })
      setTimeout(() => void check(), 8000)
      setInterval(() => void check(), EVERY)
      // Closing the app with an update downloaded: it is installed, and opens new next time.
      app.on('will-quit', () => installOnQuit && install(false))
    },
  }
}

module.exports = { setupUpdater, newer }
