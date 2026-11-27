import { deckA, deckB } from '../engine/deck'
import { library, type Entry } from '../library'
import { musicFolder } from '../musicFolder'
import { useStore } from '../store'

const STORES: [string, string][] = [
  ['Beatport', 'https://www.beatport.com/search?q='],
  ['Bandcamp', 'https://bandcamp.com/search?q='],
  ['iTunes', 'https://music.apple.com/search?term='],
]

/** Seconds of difference above which the linked file is probably another version. */
const SAME_LENGTH = 5

function pickFile(id: string) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'audio/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) library.linkFile(id, file)
  }
  input.click()
}

/**
 * The Spotify tracks in the library and the DJ's own file of each: with one, the deck plays the file
 * (BPM, waveform, stems); without, it plays through Spotify and the shops to buy it are a click away.
 */
export function SpotifyFiles() {
  const { entries } = useStore(library)
  const folder = useStore(musicFolder)
  const tracks = entries
    .filter((e) => e.kind === 'spotify')
    .map((e) => ({ track: e, own: library.localFor(e) }))
    .sort((a, b) => Number(!!a.own) - Number(!!b.own))
  const missing = tracks.filter((t) => !t.own).length

  const state = (track: Entry, own: Entry) => {
    if (library.unreadable(own)) return "File can't be read"
    if (library.waitingAnalysis(own) || library.waitingStems(own)) return 'Analysing…'
    const off = track.duration && own.duration && Math.abs(track.duration - own.duration) > SAME_LENGTH
    return off ? 'Linked · different length, check the version' : 'Linked'
  }

  return (
    <>
      <div className="spot-folder">
        {musicFolder.available ? (
          <>
            <button className="btn small" onClick={() => void musicFolder.pick()}>
              {folder.folder ? 'Change folder' : 'Choose music folder'}
            </button>
            {folder.folder && (
              <>
                <button className="btn small" disabled={folder.scanning} onClick={() => void musicFolder.scan()}>
                  Scan now
                </button>
                <button className="btn small" onClick={() => void musicFolder.forget()}>
                  Stop watching
                </button>
              </>
            )}
            <span title={folder.folder ?? undefined}>
              {folder.folder ? `${folder.folder} · ${folder.files.length} audio files` : 'Files there are linked to your tracks.'}
            </span>
          </>
        ) : (
          <span>Watching a folder needs the desktop app. Here, link files one by one.</span>
        )}
        <b>{missing} without a file</b>
      </div>
      <div className="lib-tracks spot-results">
        {tracks.length === 0 ? (
          <p className="empty">Save tracks from Search (+) to see them here.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="c-title">Title</th>
                <th className="c-artist">Artist</th>
                <th className="spot-file-state">File</th>
                <th className="spot-file-act">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map(({ track, own }) => (
                <tr
                  key={track.id}
                  onDoubleClick={() => library.loadFree(track, deckA, deckB)}
                  onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
                  onDrop={(e) => {
                    const file = e.dataTransfer.files[0]
                    if (!file) return
                    e.preventDefault()
                    e.stopPropagation()
                    library.linkFile(track.id, file)
                  }}
                >
                  <td className="c-title">{track.title}</td>
                  <td className="c-artist">{track.artist}</td>
                  <td title={own?.path}>{own ? state(track, own) : 'To buy'}</td>
                  <td className="spot-file-act" onDoubleClick={(e) => e.stopPropagation()}>
                    <div>
                    {own ? (
                      <>
                        <button className="row-btn a" onClick={() => library.load(track, deckA)} aria-label={'Deck A: ' + track.title}>
                          A
                        </button>
                        <button className="row-btn b" onClick={() => library.load(track, deckB)} aria-label={'Deck B: ' + track.title}>
                          B
                        </button>
                        <button className="btn small" onClick={() => library.unlink(track.id)}>
                          Unlink
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn small" onClick={() => pickFile(track.id)}>
                          Choose file
                        </button>
                        {STORES.map(([name, url]) => (
                          <a
                            key={name}
                            href={url + encodeURIComponent(track.artist + ' ' + track.title)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {name}
                          </a>
                        ))}
                      </>
                    )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
