/**
 * The DJ's music folder, watched so that files bought for a Spotify track are linked to it.
 * The folder is only ever chosen in the system's own dialog and remembered here: the page never
 * hands over a path.
 */
const fs = require('node:fs')
const path = require('node:path')

const AUDIO = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aiff?)$/i
const MAX_FILES = 20000
const MAX_DEPTH = 6

function setupMusicFolder({ app, dialog, ipcMain, win }) {
  const store = () => path.join(app.getPath('userData'), 'music-folder.json')
  const saved = () => {
    try {
      return JSON.parse(fs.readFileSync(store(), 'utf8')).folder || null
    } catch {
      return null
    }
  }

  async function list(dir, depth, files) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (files.length >= MAX_FILES || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory() && depth < MAX_DEPTH) await list(full, depth + 1, files)
      else if (e.isFile() && AUDIO.test(e.name)) {
        // A file written in the last seconds may still be downloading: next time.
        const stat = await fs.promises.stat(full).catch(() => null)
        if (stat && stat.size > 0 && Date.now() - stat.mtimeMs > 5000) files.push(full)
      }
    }
    return files
  }

  const scan = async () => {
    const folder = saved()
    return { folder, files: folder ? await list(folder, 0, []) : [] }
  }
  const ours = (event) => event.sender === win.webContents

  ipcMain.handle('vx:music-scan', (event) => (ours(event) ? scan() : null))
  ipcMain.handle('vx:music-pick', async (event) => {
    if (!ours(event)) return null
    const answer = await dialog.showOpenDialog(win, { title: 'Choose your music folder', properties: ['openDirectory'] })
    if (!answer.canceled && answer.filePaths[0]) fs.writeFileSync(store(), JSON.stringify({ folder: answer.filePaths[0] }))
    return scan()
  })
  ipcMain.handle('vx:music-forget', (event) => {
    if (!ours(event)) return null
    fs.rmSync(store(), { force: true })
    return scan()
  })
}

module.exports = { setupMusicFolder }
