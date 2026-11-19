/**
 * RiddimX desktop shell.
 *
 * Why it exists: in a normal browser tab the app cannot read the sound of a YouTube player, so
 * YouTube decks get no EQ, filter or stems. Here each YouTube deck lives in its own muted
 * <webview>, and the shell hands that page's audio to the app without any "share audio" prompt.
 */
const { app, BrowserWindow, ipcMain, net, session, shell, systemPreferences, webContents } = require('electron')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { setupUpdater } = require('./updater.cjs')
const { createRemote } = require('./remote.cjs')

const ORIGIN = 'http://127.0.0.1:5173'
const DECK_PAGE = ORIGIN + '/ytdeck.html'

// Deck pages are driven remotely (no click happens inside them), so they must be allowed to start playback.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// The built-in AI (stems, lyrics) runs its WebAssembly engine on every core: that needs SharedArrayBuffer.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

// Present ourselves as the plain Chrome this shell is built on (no "Electron/x virtualx/x" tokens).
// The app was called VirtualX: the packaged app keeps reading and writing its data where it always did
// (library, stems, lyrics), so renaming it to RiddimX loses nothing.
// VX_USER_DATA points a test run at a throw-away folder instead.
if (app.isPackaged) app.setPath('userData', process.env.VX_USER_DATA || path.join(app.getPath('appData'), 'VirtualX'))
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|virtualx)\/\S+/gi, '')

// A DJ app must keep exact timing while its window is covered or in the background.
for (const flag of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) {
  app.commandLine.appendSwitch(flag)
}

let vite = null
let pendingCapture = null // webContents whose audio the next getDisplayMedia() call receives

const reachable = () =>
  new Promise((resolve) => {
    const req = http.get(ORIGIN, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
  })

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', // the built-in AI engine (WebAssembly needs this exact type)
  '.onnx': 'application/octet-stream',
  '.m4a': 'audio/mp4',
}

/**
 * Packaged app: serve the built files ourselves, on the same local address the dev server uses
 * (YouTube's player and the Spotify login both need a real http origin, and saved data stays put).
 */
function serveDist() {
  const root = path.join(__dirname, '..', 'dist')
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, ORIGIN).pathname)
    const file = path.normalize(path.join(root, pathname === '/' ? 'index.html' : pathname))
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end()
      return
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
      res.end(data)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(5173, '127.0.0.1', resolve)
  })
}

async function ensureServer() {
  if (app.isPackaged) {
    // If the address is taken (a dev server is running), that one is used instead.
    await serveDist().catch(() => undefined)
    return
  }
  if (await reachable()) return
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
  vite = spawn(bin, [], { cwd: path.join(__dirname, '..'), stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await reachable()) return
  }
  throw new Error('Dev server did not start')
}

if (!app.requestSingleInstanceLock()) app.quit()
// ───────────── AI stems: separated inside the app (src/engine/ai), stored here per track ─────────────

const AUDIO_FILE = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aiff?|webm)$/i
const STEM_NAMES = ['vocals', 'drums', 'bass', 'other']
// The model the app separates with (src/engine/ai/demucs.ts MODEL). Stems made by another one are done again.
const STEM_MODEL = 'htdemucs'
const stemsDir = (id) => path.join(app.getPath('userData'), 'stems', id)

/**
 * The model that made this track's stored stems, or null when there are none. Stems by an older model
 * are kept and used until the app has separated the track again with the current one (STEM_MODEL).
 */
function stemsModel(dir) {
  if (!fs.existsSync(dir)) return null
  // The 6-stem model tried for a while: its "other" lacks the guitar and piano, not worth keeping.
  if (fs.existsSync(path.join(dir, 'guitar.m4a'))) {
    fs.rmSync(dir, { recursive: true, force: true })
    return null
  }
  if (!STEM_NAMES.every((name) => fs.existsSync(path.join(dir, name + '.m4a')))) return null
  try {
    return fs.readFileSync(path.join(dir, 'model.txt'), 'utf8').trim() || 'htdemucs'
  } catch {
    return 'htdemucs' // saved before the marker existed
  }
}

function readStems(dir) {
  if (!stemsModel(dir)) return null
  return Object.fromEntries(STEM_NAMES.map((name) => [name, fs.readFileSync(path.join(dir, name + '.m4a'))]))
}

function run(cmd, args, onLine, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } })
    let tail = ''
    child.stdout.on('data', (chunk) =>
      String(chunk)
        .split('\n')
        .forEach((line) => line && onLine && onLine(line)),
    )
    child.stderr.on('data', (chunk) => (tail = (tail + chunk).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split('\n').pop() || 'exit ' + code))))
  })
}

/** A 16-bit PCM WAV file from interleaved stereo float32. */
function wav16(pcm, rate) {
  const n = pcm.length
  const out = Buffer.alloc(44 + n * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + n * 2, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(2, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 4, 28)
  out.writeUInt16LE(4, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2)
  return out
}

/**
 * Stores the 4 stems the app separated (interleaved stereo float32 each) as AAC files for this track,
 * so the next time it loads they are there at once. afconvert comes with every Mac.
 */
async function saveStems(id, stems, rate) {
  // Made in a folder of its own and swapped in at the end: stems already there stay usable until then.
  const final = stemsDir(id)
  const dir = final + '.new'
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    for (const name of STEM_NAMES) {
      const wav = path.join(dir, name + '.wav')
      fs.writeFileSync(wav, wav16(stems[name], rate))
      await run('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '256000', wav, path.join(dir, name + '.part')])
      fs.renameSync(path.join(dir, name + '.part'), path.join(dir, name + '.m4a'))
      fs.rmSync(wav)
    }
    fs.writeFileSync(path.join(dir, 'model.txt'), STEM_MODEL)
    fs.rmSync(final, { recursive: true, force: true })
    fs.renameSync(dir, final)
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw e
  }
  return readStems(final)
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  await ensureServer()
  const ses = session.defaultSession

  // Our own pages may use MIDI and capture; nothing else may ask for anything.
  const ours = (url) => typeof url === 'string' && url.startsWith(ORIGIN + '/')
  const allowed = new Set(['midi', 'midiSysex', 'media', 'display-capture', 'speaker-selection'])
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ours(details.requestingUrl || wc.getURL()) && allowed.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => (origin === ORIGIN || ours(origin)) && allowed.has(permission))

  ses.setDisplayMediaRequestHandler((request, callback) => {
    const target = pendingCapture
    pendingCapture = null
    if (!target || target.isDestroyed() || !ours(request.frame?.url)) return callback({})
    callback({ video: target.mainFrame, audio: target.mainFrame })
  })

  // The lion in the Dock, also when running from source (the packaged app gets it from icon.icns).
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, 'icon.png'))

  const win = new BrowserWindow({
    icon: path.join(__dirname, 'icon.png'),
    width: 1440,
    height: 900,
    backgroundColor: '#0f1115',
    title: 'RiddimX',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  })

  // ⌘+ / ⌘− / ⌘0: the page's Settings own the interface size (instead of the menu's zoom).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return
    const step = input.key === '=' || input.key === '+' ? 1 : input.key === '-' ? -1 : input.key === '0' ? 0 : null
    if (step === null) return
    event.preventDefault()
    win.webContents.send('vx:zoom-key', step)
  })

  // A <webview> may only ever be one of our deck pages, with no extra privileges.
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.backgroundThrottling = false
    if (!String(params.src).startsWith(DECK_PAGE)) event.preventDefault()
  })
  app.on('web-contents-created', (_e, wc) => {
    // Links ("Procurar outra versão", YouTube logo…) open in the real browser, never inside the app.
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    if (wc.getType() === 'webview') {
      wc.setAudioMuted(true) // its sound is heard through the deck, not directly
      wc.on('will-navigate', (event, url) => {
        if (!url.startsWith(DECK_PAGE)) event.preventDefault()
      })
    }
  })

  ipcMain.handle('vx:capture', async (event, id) => {
    if (event.sender !== win.webContents) return false
    const target = webContents.fromId(id)
    if (!target || target.getType() !== 'webview' || !target.getURL().startsWith(DECK_PAGE)) return false
    target.setAudioMuted(true)
    pendingCapture = target
    // Run the page's capture call as a user gesture, so it never depends on a recent click.
    await win.webContents.executeJavaScript('window.__vxGrab && window.__vxGrab()', true)
    return true
  })

  // Library files from earlier sessions. Only absolute paths to audio files are read.
  ipcMain.handle('vx:read-audio', async (event, filePath) => {
    if (event.sender !== win.webContents || typeof filePath !== 'string') return null
    if (!path.isAbsolute(filePath) || !AUDIO_FILE.test(filePath)) return null
    try {
      return await fs.promises.readFile(filePath)
    } catch {
      return null // moved, renamed or deleted
    }
  })
  ipcMain.handle('vx:stems-available', () => true)
  // New versions from GitHub: checked, downloaded and installed when the DJ restarts (see updater.cjs).
  const updater = setupUpdater(win)
  ipcMain.handle('vx:update-state', (event) => (event.sender === win.webContents ? updater.state() : null))
  ipcMain.handle('vx:update-check', (event) => event.sender === win.webContents && updater.check(true))
  ipcMain.handle('vx:update-install', (event) => event.sender === win.webContents && updater.installNow())
  updater.start()
  // Phone as a controller (Ajustes › Celular): a server on the local Wi-Fi, off until the DJ turns it on.
  const remote = createRemote({
    dataDir: app.getPath('userData'),
    onMessage: (msg, client) => !win.isDestroyed() && win.webContents.send('vx:remote', msg, client),
    onClients: (n) => !win.isDestroyed() && win.webContents.send('vx:remote-clients', n),
  })
  const mine = (event) => event.sender === win.webContents
  ipcMain.handle('vx:remote-start', (event) => (mine(event) ? remote.start() : null))
  ipcMain.handle('vx:remote-stop', (event) => (mine(event) ? remote.stop() : null))
  ipcMain.handle('vx:remote-info', (event) => (mine(event) ? remote.info() : null))
  ipcMain.handle('vx:remote-renew', (event) => (mine(event) ? remote.renew() : null))
  ipcMain.on('vx:remote-state', (event, text) => mine(event) && typeof text === 'string' && remote.broadcast(text))
  ipcMain.on('vx:remote-reply', (event, client, text) => mine(event) && typeof text === 'string' && remote.send(client, text))
  app.on('will-quit', () => remote.stop())

  ipcMain.handle('vx:set-zoom', (event, factor) => {
    if (event.sender !== win.webContents || typeof factor !== 'number' || !(factor >= 0.5 && factor <= 2)) return
    win.webContents.setZoomFactor(factor)
  })
  ipcMain.handle('vx:stems-has', (event, id) =>
    event.sender === win.webContents && /^[0-9a-f]{40}$/.test(id) ? stemsModel(stemsDir(id)) : null,
  )
  ipcMain.handle('vx:stems-cached', (event, id) => {
    if (event.sender !== win.webContents || !/^[0-9a-f]{40}$/.test(id)) return null
    return readStems(stemsDir(id))
  })
  ipcMain.handle('vx:stems-save', (event, id, stems, rate) => {
    if (event.sender !== win.webContents || !/^[0-9a-f]{40}$/.test(id) || !stems) return null
    if (!STEM_NAMES.every((name) => stems[name] instanceof Float32Array)) return null
    return saveStems(id, stems, Number(rate) || 44100)
  })

  // Lyrics: timed lines transcribed on this Mac by whisper.cpp, cached per track and language.
  ipcMain.handle('vx:lyrics-available', () => !!whisperBin() && fs.existsSync(WHISPER_MODEL))
  // The lyrics model: is it here, and installing it on request (the renderer asks the DJ first).
  // The microphone: macOS only lets the app hear it once the user said yes, and Chromium does not ask by itself.
  ipcMain.handle('vx:mic-access', async () => {
    if (process.platform !== 'darwin') return 'granted'
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status !== 'not-determined') return status
    return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
  })
  ipcMain.handle('vx:mic-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'))

  ipcMain.handle('vx:lyrics-model', () => ({
    bin: !!whisperBin(),
    ready: fs.existsSync(WHISPER_MODEL),
    sizeMb: Math.round(MODEL_SIZE / 1048576),
  }))
  ipcMain.handle('vx:lyrics-install', (event) => {
    if (event.sender !== win.webContents) return false
    return installModel((p) => !win.isDestroyed() && win.webContents.send('vx:lyrics-install-progress', p))
  })
  ipcMain.handle('vx:lyrics-cached', async (event, id, lang) => {
    if (event.sender !== win.webContents || !/^[0-9a-f]{40}$/.test(id) || !/^[a-z]{2,4}$/.test(lang)) return null
    try {
      return JSON.parse(await fs.promises.readFile(lyricsFile(id, lang), 'utf8'))
    } catch {
      return null
    }
  })
  ipcMain.handle('vx:transcribe', (event, id, pcm, lang) => {
    if (event.sender !== win.webContents || !/^[0-9a-f]{40}$/.test(id) || !(pcm instanceof Float32Array)) return null
    if (!/^[a-z]{2,4}$/.test(lang) || !whisperBin() || !fs.existsSync(WHISPER_MODEL)) return null
    const job = lyricsQueue.then(() =>
      transcribe(id, pcm, lang, (p) => !win.isDestroyed() && win.webContents.send('vx:lyrics-progress', id, p)),
    )
    lyricsQueue = job.catch(() => undefined) // one at a time: each one uses the whole GPU
    return job
  })

  // Drops: text spoken by one of the Mac's own voices (no download), returned as WAV bytes.
  ipcMain.handle('vx:voices', async (event) => {
    if (event.sender !== win.webContents || process.platform !== 'darwin') return []
    return listVoices()
  })
  ipcMain.handle('vx:speak', async (event, text, voice, rate) => {
    if (event.sender !== win.webContents || process.platform !== 'darwin') return null
    if (typeof text !== 'string' || !text.trim() || text.length > 400) return null
    const voices = await listVoices()
    if (!voices.some((v) => v.name === voice)) return null
    const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'vx-drop-'))
    const input = path.join(dir, 'text.txt')
    const output = path.join(dir, 'drop.wav')
    try {
      await fs.promises.writeFile(input, text.trim(), 'utf8')
      const words = Math.round(Math.min(360, Math.max(90, Number(rate) || 180)))
      // Text goes in through a file, so nothing in it can be read as an option of `say`.
      await run('/usr/bin/say', [
        '-v',
        voice,
        '-r',
        String(words),
        '-f',
        input,
        '-o',
        output,
        '--file-format=WAVE',
        '--data-format=LEI16@44100',
      ])
      return await fs.promises.readFile(output)
    } catch {
      return null
    } finally {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  await win.loadURL(ORIGIN)
})

// ───────────────────────── lyrics (whisper.cpp) ─────────────────────────

// The model lives in the app's data folder (VX_USER_DATA: a test folder instead).
const MODELS_DIR = process.env.VX_USER_DATA
  ? path.join(process.env.VX_USER_DATA, 'models')
  : path.join(app.getPath('appData'), 'VirtualX', 'models')
const WHISPER_MODEL = path.join(MODELS_DIR, 'ggml-large-v3-turbo-q5_0.bin')
// Downloaded once, when the DJ presses "Instalar letras"; checked byte for byte before use.
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
const MODEL_SIZE = 574041195
const MODEL_SHA256 = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
// whisper.cpp ships with the app (built for this Mac's processor, GPU via Metal); Homebrew's as a fallback.
const whisperBin = () =>
  [
    app.isPackaged ? path.join(process.resourcesPath, 'whisper-cli') : path.join(__dirname, 'bin', process.arch, 'whisper-cli'),
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
  ].find((p) => fs.existsSync(p)) || null

let installing = null
/** Downloads the lyrics model (about 550 MB) with progress; only kept if its SHA-256 is the expected one. */
function installModel(progress) {
  if (fs.existsSync(WHISPER_MODEL)) return Promise.resolve(true)
  installing ??= (async () => {
    await fs.promises.mkdir(MODELS_DIR, { recursive: true })
    const part = WHISPER_MODEL + '.part'
    const res = await net.fetch(MODEL_URL)
    if (!res.ok || !res.body) throw new Error('download falhou (' + res.status + ')')
    const total = Number(res.headers.get('content-length')) || MODEL_SIZE
    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(part)
    let got = 0
    let shown = 0
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk)
        hash.update(buf)
        got += buf.length
        if (!out.write(buf)) await once(out, 'drain')
        if (got - shown > 2e6) {
          shown = got
          progress(got / total)
        }
      }
      out.end()
      await once(out, 'finish')
      if (got !== MODEL_SIZE || hash.digest('hex') !== MODEL_SHA256) throw new Error('the downloaded file does not match')
      await fs.promises.rename(part, WHISPER_MODEL)
    } catch (e) {
      out.destroy()
      await fs.promises.rm(part, { force: true })
      throw e
    }
    progress(1)
    return true
  })().finally(() => (installing = null))
  return installing
}
const lyricsFile = (id, lang) => path.join(app.getPath('userData'), 'lyrics', id + '-' + lang + '.json')
let lyricsQueue = Promise.resolve()

/** Mono float32 at 16 kHz as a 16-bit WAV file, what whisper.cpp reads. */
function wav16k(pcm) {
  const out = Buffer.alloc(44 + pcm.length * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + pcm.length * 2, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16000, 24)
  out.writeUInt32LE(32000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(pcm.length * 2, 40)
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2)
  return out
}

// Whisper "hears" these in silence or music: subtitle credits, thanks, music tags.
const JUNK = /legenda|transcri[çc][ãa]o|subt[ií]tulo|amara\.org|obrigad|tchau|thank(s| you)|^\W*m[uú]sic[ao]?\W*$|♪|^\W*$/i

/**
 * Keeps only lines that were really sung: drops the stock phrases above, and a line that keeps coming
 * back with very unsure words (whisper repeating itself over an instrumental).
 */
function cleanLines(segments) {
  const rows = segments.map((s) => {
    const p = (s.tokens || []).filter((t) => !String(t.text).startsWith('[_')).map((t) => t.p)
    return { time: s.offsets.from / 1000, text: String(s.text).trim(), low: p.length ? Math.min(...p) : 0 }
  })
  const count = {}
  rows.forEach((r) => (count[r.text.toLowerCase()] = (count[r.text.toLowerCase()] || 0) + 1))
  const kept = rows.filter((r) => !JUNK.test(r.text) && !(count[r.text.toLowerCase()] >= 3 && r.low < 0.15))
  return kept.length >= 3 ? kept.map(({ time, text }) => ({ time, text })) : [] // two stray lines = instrumental
}

async function transcribe(id, pcm, lang, progress) {
  const file = lyricsFile(id, lang)
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch {
    /* not done yet */
  }
  const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'vx-lyrics-'))
  try {
    const input = path.join(dir, 'voice.wav')
    await fs.promises.writeFile(input, wav16k(pcm))
    const base = path.join(dir, 'out')
    await new Promise((resolve, reject) => {
      const args = [
        '-m',
        WHISPER_MODEL,
        '-f',
        input,
        '-l',
        lang,
        '-ojf',
        '-of',
        base,
        '-ml',
        '60',
        '-sow',
        '-sns',
        '-mc',
        '0',
        '-pp',
        '-np',
      ]
      const child = spawn(whisperBin(), args)
      let tail = ''
      child.stderr.on('data', (chunk) => {
        tail = (tail + chunk).slice(-4000)
        const m = String(chunk).match(/progress\s*=\s*(\d+)%/g)
        if (m) progress(Number(m.pop().match(/(\d+)/)[1]) / 100)
      })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split('\n').pop() || 'exit ' + code))))
    })
    const json = JSON.parse(await fs.promises.readFile(base + '.json', 'utf8'))
    const lines = cleanLines(json.transcription || [])
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, JSON.stringify(lines))
    return lines
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// Novelty voices that sing or make noises: no use for a spoken drop.
const NOVELTY = /^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)$/
let voiceList = null
async function listVoices() {
  if (voiceList) return voiceList
  // Whole output at once: the line-by-line reader of run() can split a line between two chunks.
  const out = await new Promise((resolve) => execFile('/usr/bin/say', ['-v', '?'], (error, stdout) => resolve(error ? '' : String(stdout))))
  voiceList = out
    .split('\n')
    .map((line) => line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/))
    .filter(Boolean)
    .map((m) => ({ name: m[1].trim(), lang: m[2] }))
    .filter((v) => /^(pt|en|es|fr|it)_/.test(v.lang) && !NOVELTY.test(v.name))
  return voiceList
}

app.on('window-all-closed', () => app.quit())
app.on('quit', () => vite?.kill())
