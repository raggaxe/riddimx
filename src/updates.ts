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
      return 'Procurando versão nova…'
    case 'none':
      return u.error ? 'Sem atualizações (' + u.error + ')' : 'Você está na versão mais nova'
    case 'available':
      return 'Versão ' + u.version + ' disponível' + (u.error ? ' (' + u.error + ')' : '')
    case 'downloading':
      return 'Baixando a versão ' + u.version + ' · ' + Math.round((u.progress ?? 0) * 100) + '%'
    case 'ready':
      return 'Versão ' + u.version + ' pronta: instala ao reiniciar'
    case 'error':
      return 'Não deu para atualizar: ' + u.error
    case 'dev':
      return 'Atualização automática só na app instalada'
    default:
      return ''
  }
}
