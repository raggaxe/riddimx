/**
 * Downloads an audio file from a direct link (a promo from a label, Dropbox, Google Drive, a plain
 * .mp3 / .wav / .flac URL) into Music/RiddimX Downloads, so it can go straight into the library.
 * Only http(s), only audio: a web page or anything else is refused and nothing is kept.
 */
const fs = require('node:fs')
const path = require('node:path')

const AUDIO = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aiff?)$/i
const MAX_BYTES = 1024 * 1024 * 1024 // 1 GB
const TYPES = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/aiff': '.aiff',
  'audio/x-aiff': '.aiff',
}

class Refused extends Error {}

/** Share links that point at a page about the file, turned into the link of the file itself. */
function direct(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new Refused('That is not a link. Paste the full address, starting with https://')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Refused('Only http and https links can be downloaded.')
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    url.searchParams.delete('dl')
    url.searchParams.set('dl', '1')
    return url.toString()
  }
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const id = url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] || url.searchParams.get('id')
    if (!id) throw new Refused('Use the link of one file on Google Drive (Share › Copy link), not of a folder.')
    return 'https://drive.usercontent.google.com/download?export=download&confirm=t&id=' + encodeURIComponent(id)
  }
  if (host === 'wetransfer.com' || host === 'we.tl' || host.endsWith('.wetransfer.com')) {
    throw new Refused('WeTransfer links open a page, not the file: open it in the browser, download, and drag the file into RiddimX.')
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com') || host.endsWith('spotify.com')) {
    throw new Refused('YouTube and Spotify links are not downloaded: paste them in the library search to play them.')
  }
  return url.toString()
}

/** The file's name from the answer's headers, else from the link. */
function nameOf(res, url) {
  const cd = res.headers.get('content-disposition') || ''
  let name = ''
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      name = ''
    }
  }
  if (!name) name = (cd.match(/filename\s*=\s*"([^"]+)"/) || cd.match(/filename\s*=\s*([^;]+)/) || [])[1] || ''
  if (!name) {
    try {
      name = decodeURIComponent(new URL(res.url || url).pathname.split('/').pop() || '')
    } catch {
      name = ''
    }
  }
  // No folders, nothing hidden, nothing the file system refuses.
  name = path.basename(name.trim()).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 180)
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!AUDIO.test(name) && TYPES[type]) name = (name || 'download') + TYPES[type]
  return { name, type }
}

/** "Track.mp3", or "Track (2).mp3" when that one is already there. */
function freePath(dir, name) {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const p = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`)
    if (!fs.existsSync(p) && !fs.existsSync(p + '.part')) return p
  }
}

function setupDownloads({ app, ipcMain, net, shell, win }) {
  const folder = () => path.join(app.getPath('music'), 'RiddimX Downloads')
  const running = new Map() // id → AbortController
  let next = 1
  const ours = (event) => event.sender === win.webContents
  const tell = (state) => {
    if (!win.isDestroyed()) win.webContents.send('vx:dl', state)
  }

  async function run(id, link, abort) {
    const base = { id, url: link }
    let part = ''
    let out = null
    try {
      const url = direct(link)
      tell({ ...base, status: 'downloading', name: '', received: 0, total: 0 })
      const res = await net.fetch(url, { signal: abort.signal, redirect: 'follow' })
      if (!res.ok) throw new Refused(res.status === 404 ? 'Nothing at that link (404). It may have expired.' : 'The server answered ' + res.status + '.')
      const { name, type } = nameOf(res, url)
      if (type.startsWith('text/html')) {
        throw new Refused('That link opens a web page, not an audio file. Use the download link of the file itself.')
      }
      if (!name || !AUDIO.test(name)) {
        throw new Refused('Not an audio file (' + (type || 'unknown type') + '). MP3, WAV, FLAC, AIFF, M4A, OGG and OPUS can be downloaded.')
      }
      const total = Number(res.headers.get('content-length')) || 0
      if (total > MAX_BYTES) throw new Refused('Too big: over 1 GB.')
      await fs.promises.mkdir(folder(), { recursive: true })
      const final = freePath(folder(), name)
      part = final + '.part'
      out = fs.createWriteStream(part)
      const reader = res.body.getReader()
      let received = 0
      let shown = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (received > MAX_BYTES) throw new Refused('Too big: over 1 GB.')
        if (!out.write(value)) await new Promise((r) => out.once('drain', r))
        if (Date.now() - shown > 150) {
          shown = Date.now()
          tell({ ...base, status: 'downloading', name: path.basename(final), received, total })
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
      out = null
      if (!received) throw new Refused('The file is empty.')
      await fs.promises.rename(part, final)
      part = ''
      tell({ ...base, status: 'done', name: path.basename(final), received, total: received, path: final })
    } catch (e) {
      out?.destroy()
      if (part) await fs.promises.rm(part, { force: true }).catch(() => undefined)
      const cancelled = abort.signal.aborted
      tell({
        ...base,
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? '' : e instanceof Refused ? e.message : "Couldn't download: " + (e?.message || e),
      })
    } finally {
      running.delete(id)
    }
  }

  ipcMain.handle('vx:dl-start', (event, link) => {
    if (!ours(event) || typeof link !== 'string' || link.length > 4000) return null
    const id = next++
    const abort = new AbortController()
    running.set(id, abort)
    void run(id, link, abort)
    return id
  })
  ipcMain.handle('vx:dl-cancel', (event, id) => {
    if (ours(event)) running.get(id)?.abort()
  })
  // Shows a downloaded file in Finder / Explorer: only files in the downloads folder.
  ipcMain.handle('vx:dl-reveal', (event, file) => {
    if (!ours(event) || typeof file !== 'string') return
    const p = path.resolve(file)
    if (p.startsWith(folder() + path.sep) && fs.existsSync(p)) shell.showItemInFolder(p)
    else if (!file) void shell.openPath(folder())
  })
  ipcMain.handle('vx:dl-folder', (event) => (ours(event) ? folder() : null))
}

module.exports = { setupDownloads }
