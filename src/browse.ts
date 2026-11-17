import { Store } from './store'
import { ui } from './ui'

/**
 * The controller's browser section talking to the library: move the selection, load the selected track.
 * A request waits here until the library panel takes it (the library tab is opened for it if needed).
 */
export interface BrowseRequest {
  step: number // rows to move the selection (negative = up)
  load: 'A' | 'B' | 'free' | null
}

class Browse extends Store<{ pending: BrowseRequest[] }> {
  constructor() {
    super({ pending: [] })
  }

  ask(request: BrowseRequest): void {
    if (ui.get().tab !== 'library') ui.open('library')
    this.set({ pending: [...this.state.pending, request] })
  }

  take(): BrowseRequest[] {
    const pending = this.state.pending
    if (pending.length) this.set({ pending: [] })
    return pending
  }
}

export const browse = new Browse()
const ask = (request: BrowseRequest) => browse.ask(request)

export const browseStep = (rows: number): void => ask({ step: rows, load: null })
export const browseLoad = (deck: 'A' | 'B' | 'free'): void => ask({ step: 0, load: deck })

/** The library panel takes every waiting request at once. */
export const takeBrowse = (): BrowseRequest[] => browse.take()
