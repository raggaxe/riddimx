import { Store } from './store'
import { desktop, type UpdateState } from './engine/ytremote'

/** The desktop app's updater, as the page sees it: a new version found, downloading, ready to install. */
class Updates extends Store<UpdateState> {
  constructor() {
    super({ status: desktop?.onUpdate ? 'idle' : 'dev', current: '' })
    desktop?.onUpdate?.((state) => this.set(state))
    void desktop?.updateState?.().then((state) => state && this.set(state))
  }

  check(): void {
    void desktop?.updateCheck?.()
  }

  /** Quits and opens the new version. */
  install(): void {
    void desktop?.updateInstall?.()
  }
}

export const updates = new Updates()

/** What to tell the DJ about it, in a few words. */
export function updateText(u: UpdateState): string {
  switch (u.status) {
    case 'checking':
      return 'Looking for a new version…'
    case 'none':
      return u.error ? 'No updates (' + u.error + ')' : 'You\'re on the latest version'
    case 'available':
      return 'Version ' + u.version + ' available' + (u.error ? ' (' + u.error + ')' : '')
    case 'downloading':
      return 'Downloading version ' + u.version + ' · ' + Math.round((u.progress ?? 0) * 100) + '%'
    case 'ready':
      return 'Version ' + u.version + ' ready: installs on restart'
    case 'error':
      return 'Couldn\'t update: ' + u.error
    case 'dev':
      return 'Automatic updates only in the installed app'
    default:
      return ''
  }
}
