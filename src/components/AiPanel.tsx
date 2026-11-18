import { LYRICS_LANGS, lyrics, type LyricsLang } from '../engine/lyrics'
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
      ? 'Verificando…'
      : lyr.model === 'none'
        ? 'Só na app do Mac'
        : lyr.model === 'ready'
          ? 'Instalado'
          : lyr.model === 'installing'
            ? 'Instalando ' + Math.round(lyr.modelProgress * 100) + '%'
            : 'Não instalado'

  return (
    <div className="ap2 st">
      <section className="mx-sec ap2-unit" aria-label="Letras">
        <header className="ap2-head">
          <b>Letras</b>
          <span>transcritas no Mac quando o catálogo não conhece a música</span>
        </header>
        <div className="ap2-body">
          <label className="st-field" title="Língua em que as músicas são cantadas: ajuda a transcrever as letras">
            Idioma
            <select value={lyr.lang} onChange={(e) => lyrics.setLang(e.target.value as LyricsLang)} aria-label="Idioma das letras">
              {LYRICS_LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <span className="ap2-info">
            Modelo: <b className={lyr.model === 'ready' ? 'st-ok' : ''}>{model}</b>
          </span>
          {(lyr.model === 'missing' || lyr.model === 'installing') && (
            <button
              className={'ap2-btn' + (lyr.modelError ? ' st-err' : '')}
              disabled={lyr.model === 'installing'}
              onClick={() => void lyrics.installModel()}
              title={'Baixa uma vez o modelo de letras (' + lyr.modelSizeMb + ' MB, da Hugging Face)'}
            >
              {lyr.modelError ? 'TENTAR DE NOVO' : 'INSTALAR · ' + lyr.modelSizeMb + ' MB'}
            </button>
          )}
        </div>
        {lyr.modelError && <p className="deck-msg error ap2-err">A instalação falhou: {lyr.modelError}</p>}
      </section>

      <section className="mx-sec ap2-unit" aria-label="Stems IA">
        <header className="ap2-head">
          <b>Stems IA</b>
          <span>voz, bateria, baixo e instrumentos separados</span>
        </header>
        <div className="ap2-body">
          <span className="ap2-info">
            Modelo: <b>{MODEL}</b>
          </span>
          <span className="ap2-info">
            {lib.separating
              ? 'Separando ' + Math.round(lib.sepProgress * 100) + '%' + (waiting > 1 ? ' · mais ' + (waiting - 1) + ' na fila' : '')
              : waiting
                ? waiting + ' na fila'
                : 'Biblioteca em dia'}
            {upgrading > 0 && ' · ' + upgrading + ' para refazer com o modelo novo'}
          </span>
        </div>
        <p className="ap2-hint">
          Cada música nova é separada ao entrar na biblioteca, e só fica disponível quando os stems ficam prontos. Os
          stems ficam salvos no Mac: a mesma música não é separada duas vezes.
        </p>
      </section>
    </div>
  )
}
