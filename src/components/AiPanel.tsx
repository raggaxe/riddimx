import { LYRICS_LANGS, LYRICS_ON, lyrics, type LyricsLang } from '../engine/lyrics'
import { MODEL } from '../engine/ai/demucs'
import { library } from '../library'
import { useStore } from '../store'

/**
 * Ajustes › Letras e IA: the language the songs are sung in and the lyrics model (whisper, on this
 * Mac), and how the AI stem separation of the library is going.
 */
export function AiPanel() {
  const lyr = useStore(lyrics)
  const lib = useStore(library)
  const waiting = lib.stemsWaiting.length
  const upgrading = lib.stemsUpgrade.length

  const model =
    lyr.model === 'checking'
      ? 'Checking…'
      : lyr.model === 'none'
        ? 'Mac app only'
        : lyr.model === 'ready'
          ? 'Installed'
          : lyr.model === 'installing'
            ? 'Installing ' + Math.round(lyr.modelProgress * 100) + '%'
            : 'Not installed'

  return (
    <div className="ap2 st">
      {LYRICS_ON && (
      <section className="mx-sec ap2-unit" aria-label="Lyrics">
        <header className="ap2-head">
          <b>Lyrics</b>
          <span>transcribed on the Mac when the catalogue doesn't know the song</span>
        </header>
        <div className="ap2-body">
          <label className="st-field" title="Language the songs are sung in: helps transcribe the lyrics">
            Language
            <select value={lyr.lang} onChange={(e) => lyrics.setLang(e.target.value as LyricsLang)} aria-label="Lyrics language">
              {LYRICS_LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <span className="ap2-info">
            Model: <b className={lyr.model === 'ready' ? 'st-ok' : ''}>{model}</b>
          </span>
          {(lyr.model === 'missing' || lyr.model === 'installing') && (
            <button
              className={'ap2-btn' + (lyr.modelError ? ' st-err' : '')}
              disabled={lyr.model === 'installing'}
              onClick={() => void lyrics.installModel()}
              title={'Downloads the lyrics model once (' + lyr.modelSizeMb + ' MB, from Hugging Face)'}
            >
              {lyr.modelError ? 'TRY AGAIN' : 'INSTALL · ' + lyr.modelSizeMb + ' MB'}
            </button>
          )}
        </div>
      </section>
      )}

      <section className="mx-sec ap2-unit" aria-label="Stems IA">
        <header className="ap2-head">
          <b>Stems IA</b>
          <span>vocals, drums, bass and instruments apart</span>
        </header>
        <div className="ap2-body">
          <span className="ap2-info">
            Model: <b>{MODEL}</b>
          </span>
          <span className="ap2-info">
            {lib.separating
              ? 'Splitting ' + Math.round(lib.sepProgress * 100) + '%' + (waiting > 1 ? ' · ' + (waiting - 1) + ' more queued' : '')
              : waiting
                ? waiting + ' queued'
                : 'Library up to date'}
            {upgrading > 0 && ' · ' + upgrading + ' to redo with the new model'}
          </span>
        </div>
        <p className="ap2-hint">
          Every new track is split as it enters the library, and is only available once its stems are ready. Stems are kept on the Mac: the same track is never split twice.
        </p>
      </section>
    </div>
  )
}
