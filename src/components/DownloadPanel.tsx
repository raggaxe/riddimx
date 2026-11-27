import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { deckA, deckB, type Deck } from '../engine/deck'
import { downloads, type Download } from '../downloads'
import { library } from '../library'
import { useStore } from '../store'

const mb = (n?: number) => (n ? (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB' : '')

/** Download tab: paste a direct link to an audio file; it downloads and goes into the library. */
export function DownloadPanel() {
  const { list, folder } = useStore(downloads)
  const [url, setUrl] = useState('')
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  // The link field lives on the tab row, like the library's search.
  useEffect(() => setSlot(document.getElementById('tab-tools')), [])

  const go = async () => {
    if (await downloads.start(url)) setUrl('')
  }

  const bar = (
    <div className="lib-bar dl-bar">
      <form
        className="lib-search dl-url"
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <input
          type="url"
          value={url}
          placeholder="Paste a link to an audio file: Dropbox, Google Drive, or a .mp3 / .wav / .flac address"
          aria-label="Link to an audio file"
          spellCheck={false}
          disabled={!downloads.available}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setUrl('')}
        />
      </form>
      <button className="btn" onClick={() => void go()} disabled={!url.trim() || !downloads.available}>
        Download
      </button>
      {downloads.available && (
        <button className="btn" onClick={() => downloads.reveal()} title={folder ?? undefined}>
          Open folder
        </button>
      )}
    </div>
  )

  return (
    <div className="dl">
      {slot ? createPortal(bar, slot) : bar}
      {!downloads.available ? (
        <p className="empty">Downloading files needs the RiddimX desktop app.</p>
      ) : list.length === 0 ? (
        <div className="dl-empty">
          <p className="empty">Paste a link above and press Download. The file is saved in your Music folder and goes into the library, ready to play.</p>
          <ul className="dl-hints">
            <li>
              <b>Direct links</b> to MP3, WAV, FLAC, AIFF, M4A, OGG or OPUS files (label promos, your own server).
            </li>
            <li>
              <b>Dropbox</b> and <b>Google Drive</b> share links to one file.
            </li>
            <li>
              <b>Not</b> YouTube, Spotify or WeTransfer pages: those open a web page, not the file.
            </li>
          </ul>
        </div>
      ) : (
        <div className="lib-tracks dl-list">
          <table>
            <thead>
              <tr>
                <th className="c-title">File</th>
                <th className="dl-state">Status</th>
                <th className="c-num">Size</th>
                <th className="c-act" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <Row key={d.id} d={d} />
              ))}
            </tbody>
          </table>
          {list.some((d) => d.status !== 'downloading') && (
            <button className="btn small dl-clear" onClick={() => downloads.clear()}>
              Clear finished
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ d }: { d: Download }) {
  const entry = d.entryId ? library.byId(d.entryId) : undefined
  const load = (deck: Deck) => entry && library.load(entry, deck)
  const share = d.total ? Math.min(1, (d.received ?? 0) / d.total) : 0
  const title = d.name || d.url
  return (
    <tr className={'dl-row ' + d.status}>
      <td className="c-title" title={d.url}>
        {title}
      </td>
      <td className="dl-state">
        {d.status === 'downloading' ? (
          d.total ? (
            <span className="dl-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
              <i style={{ width: Math.round(share * 100) + '%' }} />
              <small>{Math.round(share * 100)}%</small>
            </span>
          ) : (
            <small>{d.received ? 'downloading…' : 'starting…'}</small>
          )
        ) : d.status === 'done' ? (
          <small className="ok">In the library</small>
        ) : d.status === 'cancelled' ? (
          <small>Cancelled</small>
        ) : (
          <small className="err" title={d.error}>
            {d.error}
          </small>
        )}
      </td>
      <td className="c-num">{mb(d.status === 'done' ? d.total : d.received)}</td>
      <td className="c-act">
        {d.status === 'downloading' && (
          <button className="row-btn" onClick={() => downloads.cancel(d.id)} aria-label={'Cancel ' + title} title="Cancel">
            ×
          </button>
        )}
        {d.status === 'done' && entry && (
          <>
            <button className="row-btn a" onClick={() => load(deckA)} aria-label={'Play on deck A: ' + title}>
              A
            </button>
            <button className="row-btn b" onClick={() => load(deckB)} aria-label={'Play on deck B: ' + title}>
              B
            </button>
            <button className="row-btn" onClick={() => downloads.reveal(d.path)} aria-label={'Show ' + title + ' in its folder'} title="Show in folder">
              ↗
            </button>
          </>
        )}
        {(d.status === 'error' || d.status === 'cancelled') && (
          <button className="row-btn" onClick={() => downloads.remove(d.id)} aria-label={'Remove ' + title + ' from the list'} title="Remove from the list">
            ×
          </button>
        )}
      </td>
    </tr>
  )
}
