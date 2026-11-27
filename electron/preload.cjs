const { contextBridge, ipcRenderer, webUtils } = require('electron')

// What the page can ask the desktop shell for: the sound of one of its own YouTube deck pages
// (identified by that <webview>'s id), and AI stems of a local file.
contextBridge.exposeInMainWorld('vxDesktop', {
  capture: (webContentsId) => ipcRenderer.invoke('vx:capture', webContentsId),
  // Library: where a dropped / picked audio file lives, and reading it back in a later session.
  pathOf: (file) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  readAudio: (filePath) => ipcRenderer.invoke('vx:read-audio', filePath),
  // The DJ's music folder: its audio files, choosing it, and forgetting it.
  musicScan: () => ipcRenderer.invoke('vx:music-scan'),
  musicPick: () => ipcRenderer.invoke('vx:music-pick'),
  musicForget: () => ipcRenderer.invoke('vx:music-forget'),
  // Audio files from a direct link (Dropbox, Google Drive, a plain .mp3 / .wav URL) into Music/RiddimX Downloads.
  dlStart: (url) => ipcRenderer.invoke('vx:dl-start', url),
  dlCancel: (id) => ipcRenderer.invoke('vx:dl-cancel', id),
  dlReveal: (file) => ipcRenderer.invoke('vx:dl-reveal', file),
  dlFolder: () => ipcRenderer.invoke('vx:dl-folder'),
  onDownload: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('vx:dl', listener)
    return () => ipcRenderer.removeListener('vx:dl', listener)
  },
  // AI stems of a local file: id = SHA-1 of the file, pcm = interleaved stereo float32.
  stemsAvailable: () => ipcRenderer.invoke('vx:stems-available'),
  stemsHas: (id) => ipcRenderer.invoke('vx:stems-has', id),
  // Size of the interface, and the ⌘+ / ⌘− / ⌘0 keys (the page decides, so its setting stays in step).
  setZoom: (factor) => ipcRenderer.invoke('vx:set-zoom', factor),
  // App updates (GitHub releases): state, look now, and restart into the downloaded version.
  updateState: () => ipcRenderer.invoke('vx:update-state'),
  updateCheck: () => ipcRenderer.invoke('vx:update-check'),
  updateInstall: () => ipcRenderer.invoke('vx:update-install'),
  updateDownload: () => ipcRenderer.invoke('vx:update-download'),
  // Spotify login in its own window: { code } or { error }.
  spotifyAuth: (url, redirect) => ipcRenderer.invoke('vx:spotify-auth', url, redirect),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('vx:update', listener)
    return () => ipcRenderer.removeListener('vx:update', listener)
  },
  // Phone as a controller over the Wi-Fi: turn the server on / off, its address, and the phone's messages.
  remoteStart: () => ipcRenderer.invoke('vx:remote-start'),
  remoteStop: () => ipcRenderer.invoke('vx:remote-stop'),
  remoteInfo: () => ipcRenderer.invoke('vx:remote-info'),
  remoteRenew: () => ipcRenderer.invoke('vx:remote-renew'),
  liveStart: () => ipcRenderer.invoke('vx:live-start'),
  liveStop: () => ipcRenderer.invoke('vx:live-stop'),
  liveInfo: () => ipcRenderer.invoke('vx:live-info'),
  liveSend: (id, text) => ipcRenderer.send('vx:live-send', id, text),
  liveKick: (id) => ipcRenderer.send('vx:live-kick', id),
  liveReset: () => ipcRenderer.invoke('vx:live-reset'),
  onLive: (callback) => {
    const listener = (_e, ev) => callback(ev)
    ipcRenderer.on('vx:live', listener)
    return () => ipcRenderer.removeListener('vx:live', listener)
  },
  remoteState: (text) => ipcRenderer.send('vx:remote-state', text),
  remoteReply: (client, text) => ipcRenderer.send('vx:remote-reply', client, text),
  onRemote: (callback) => {
    const listener = (_event, msg, client) => callback(msg, client)
    ipcRenderer.on('vx:remote', listener)
    return () => ipcRenderer.removeListener('vx:remote', listener)
  },
  onRemoteClients: (callback) => {
    const listener = (_event, n) => callback(n)
    ipcRenderer.on('vx:remote-clients', listener)
    return () => ipcRenderer.removeListener('vx:remote-clients', listener)
  },
  onZoomKey: (callback) => {
    const listener = (_event, step) => callback(step)
    ipcRenderer.on('vx:zoom-key', listener)
    return () => ipcRenderer.removeListener('vx:zoom-key', listener)
  },
  stemsCached: (id) => ipcRenderer.invoke('vx:stems-cached', id),
  stemsSave: (id, stems, rate) => ipcRenderer.invoke('vx:stems-save', id, stems, rate),
  // Lyrics transcribed on this Mac (whisper.cpp, when installed): pcm = mono float32 at 16 kHz.
  lyricsAvailable: () => ipcRenderer.invoke('vx:lyrics-available'),
  // The lyrics model: whether it is installed, and downloading it (about 550 MB) when the DJ asks.
  micAccess: () => ipcRenderer.invoke('vx:mic-access'),
  micSettings: () => ipcRenderer.invoke('vx:mic-settings'),
  lyricsModel: () => ipcRenderer.invoke('vx:lyrics-model'),
  lyricsInstall: () => ipcRenderer.invoke('vx:lyrics-install'),
  onLyricsInstallProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('vx:lyrics-install-progress', listener)
    return () => ipcRenderer.removeListener('vx:lyrics-install-progress', listener)
  },
  lyricsCached: (id, lang) => ipcRenderer.invoke('vx:lyrics-cached', id, lang),
  transcribe: (id, pcm, lang) => ipcRenderer.invoke('vx:transcribe', id, pcm, lang),
  onLyricsProgress: (callback) => {
    const listener = (_event, id, progress) => callback(id, progress)
    ipcRenderer.on('vx:lyrics-progress', listener)
    return () => ipcRenderer.removeListener('vx:lyrics-progress', listener)
  },
  // Drops: the Mac's voices, and a line of text spoken by one of them (WAV bytes).
  voices: () => ipcRenderer.invoke('vx:voices'),
  speak: (text, voice, rate) => ipcRenderer.invoke('vx:speak', text, voice, rate),
  onStemsProgress: (callback) => {
    const listener = (_event, id, progress) => callback(id, progress)
    ipcRenderer.on('vx:stems-progress', listener)
    return () => ipcRenderer.removeListener('vx:stems-progress', listener)
  },
})
