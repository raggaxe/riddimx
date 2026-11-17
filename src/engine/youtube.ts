/* eslint-disable @typescript-eslint/no-explicit-any */
let apiPromise: Promise<any> | null = null

/** Loads the official YouTube IFrame Player API once. */
export function loadYT(): Promise<any> {
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const w = window as any
      if (w.YT?.Player) return resolve(w.YT)
      const previous = w.onYouTubeIframeAPIReady
      w.onYouTubeIframeAPIReady = () => {
        previous?.()
        resolve(w.YT)
      }
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.onerror = () => {
        apiPromise = null
        reject(new Error('Não foi possível carregar o player do YouTube'))
      }
      document.head.appendChild(script)
    })
  }
  return apiPromise
}

export function parseYouTubeId(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '')
  let id: string | null = null
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v')
    if (!id) {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?]+)/)
      id = m ? m[1] : null
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null
}
