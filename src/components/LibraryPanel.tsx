import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { deckA, deckB, type Deck } from '../engine/deck'
import { ENTRY_DRAG, RIDDIMS_ON, library, type Entry } from '../library'
import { useStore } from '../store'
import { browse, takeBrowse } from '../browse'
import { bpmStore } from '../engine/bpm'
import { camelot, harmonic, keyStore } from '../engine/key'
import { parseYouTubeId } from '../engine/youtube'
import { parseSpotifyTrack } from '../engine/spotify'
import { LYRICS_LANGS, lyrics, type LyricsLang } from '../engine/lyrics'

const KIND_LABEL = { local: 'Ficheiro', youtube: 'YouTube', spotify: 'Spotify' }
const KIND_MARK = { local: 'F', youtube: 'YT', spotify: 'SP' }

type Smart = 'match' | 'tempo' | 'key' | 'fresh' | 'played'
const SMART: { id: Smart; label: string; hint: string }[] = [
  {
    id: 'match',
    label: 'Combina',
    hint: 'Tempo e tom compatíveis com o deck que está a tocar, ainda não tocadas: as melhores para a seguir',
  },
  { id: 'tempo', label: 'Mesmo tempo', hint: 'Tempo a menos de 6 % do deck que está a tocar (ou metade / dobro)' },
  { id: 'key', label: 'Tom compatível', hint: 'Tom que mistura com o do deck que está a tocar (roda de Camelot)' },
  { id: 'fresh', label: 'Por tocar', hint: 'Ainda não tocadas nesta sessão' },
  { id: 'played', label: 'Tocadas', hint: 'Já carregadas num deck nesta sessão, pela ordem em que tocaram' },
]

type Column = 'title' | 'artist' | 'bpm' | 'key' | 'duration' | 'kind'
interface Sort {
  by: Column | null // null = order added
  desc: boolean
}
const LS_SORT = 'vx_lib_sort'

function savedSort(): Sort {
  try {
    return { by: null, desc: false, ...JSON.parse(localStorage.getItem(LS_SORT) || '{}') }
  } catch {
    return { by: null, desc: false }
  }
}

const clock = (s: number) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')
const hours = (s: number) => (s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min' : Math.round(s / 60) + ' min')

/** A tempo that mixes with the playing deck: within 6 %, or at half / double time. */
function tempoMatch(a: number | null, b: number | null): boolean {
  if (!a || !b) return false
  return [1, 0.5, 2].some((k) => Math.abs((a * k) / b - 1) <= 0.06)
}

export function LibraryPanel() {
  // The search bar lives on the tab row (App's #tab-tools), so the list gets that row's height.
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => setSlot(document.getElementById('tab-tools')), [])
  const { entries, lists, error, analyzing, onDeck, played, riddims, riddimView } = useStore(library)
  const riddim = riddims.find((r) => r.key === riddimView) ?? null
  const [renaming, setRenaming] = useState<string | null>(null)
  const bpm = useStore(bpmStore)
  const a = useStore(deckA)
  const b = useStore(deckB)
  const [list, setList] = useState<string | null>(null) // null = every track
  // Smart lists, worked out from what is playing now: they need nothing set up.
  const [smart, setSmart] = useState<Smart | null>(null)
  const [naming, setNaming] = useState<string | null>(null) // new list being typed
  const lyr = useStore(lyrics)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>(savedSort)
  const [selected, setSelected] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLTableSectionElement>(null)
  // Rows that were already there when the panel opened never animate; only ones added afterwards do.
  const initial = useRef(new Set(entries.map((e) => e.id)))

  // The field is both search and link box: a YouTube / Spotify link offers to load it, anything else filters.
  const isLink = !!(parseYouTubeId(query.trim()) || parseSpotifyTrack(query.trim()))
  const words = isLink ? [] : query.toLowerCase().split(/\s+/).filter(Boolean)

  // The deck everything is compared against: the one playing (A first), else the one with music.
  const live = a.playing ? a : b.playing ? b : a.kind !== 'none' ? a : b.kind !== 'none' ? b : null
  const liveBpm = live?.bpm ? live.bpm * live.rate : null
  const liveKey = live === a ? deckA.heardKey : live === b ? deckB.heardKey : null // as heard, pitch included

  const tempoOf = (e: Entry): number | null => {
    if (e.kind === 'local') return e.bpm ?? null
    return bpm.bpms[e.kind + ':' + e.ref] ?? null
  }
  const lyricsKey = (e: Entry): string => (e.kind === 'local' ? 'file:' + e.title : e.kind + ':' + e.ref)
  const keyOf = (e: Entry): string | null => (e.kind === 'local' ? (e.key ?? null) : keyStore.get(e.kind + ':' + e.ref))

  const shown = useMemo(() => {
    // A riddim open: its versions, in library order; otherwise the chosen list.
    let rows = riddim
      ? entries.filter((e) => riddim.members.includes(e.id))
      : list === null
        ? entries
        : entries.filter((e) => e.list === list)
    // Smart lists (on top of the chosen list): the decks themselves are never offered.
    if (smart) {
      const now = new Set(Object.values(onDeck))
      if (smart === 'played') rows = played.map((id) => rows.find((e) => e.id === id)).filter((e): e is Entry => !!e)
      else if (smart === 'fresh') rows = rows.filter((e) => !played.includes(e.id))
      else {
        rows = rows.filter((e) => !now.has(e.id))
        if (smart === 'tempo') rows = rows.filter((e) => tempoMatch(tempoOf(e), liveBpm))
        else if (smart === 'key') rows = rows.filter((e) => harmonic(keyOf(e), liveKey))
        else rows = rows.filter((e) => !played.includes(e.id) && tempoMatch(tempoOf(e), liveBpm) && harmonic(keyOf(e), liveKey))
      }
    }
    // A search also looks inside the lyrics found or transcribed so far ("the one that says Jah Rastafari").
    if (words.length)
      rows = rows.filter((e) => {
        if (words.every((w) => (e.title + ' ' + e.artist).toLowerCase().includes(w))) return true
        const sung = lyrics.textFor(lyricsKey(e)).toLowerCase()
        return !!sung && words.every((w) => sung.includes(w))
      })
    if (!sort.by) return sort.desc ? [...rows].reverse() : rows
    const value = (e: Entry): string | number => {
      switch (sort.by) {
        case 'title':
          return e.title.toLowerCase()
        case 'artist':
          return e.artist.toLowerCase()
        case 'bpm':
          return tempoOf(e) ?? Infinity
        case 'key': {
          const c = camelot(keyOf(e))
          return c ? parseInt(c) * 2 + (c.endsWith('B') ? 1 : 0) : Infinity
        }
        case 'duration':
          return e.duration ?? Infinity
        default:
          return e.kind
      }
    }
    const dir = sort.desc ? -1 : 1
    return [...rows].sort((x, y) => {
      const p = value(x)
      const q = value(y)
      if (p === q) return 0
      if (p === Infinity) return 1 // unknown values always last
      if (q === Infinity) return -1
      return (p < q ? -1 : 1) * dir
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, list, query, sort, bpm, analyzing, lyr.lines, riddim, smart, played, onDeck, liveBpm, liveKey])

  const total = shown.reduce((sum, e) => sum + (e.duration ?? 0), 0)

  const sortBy = (by: Column) => {
    // Click: ascending, again: descending, a third time: back to the order added.
    const next: Sort = sort.by !== by ? { by, desc: false } : !sort.desc ? { by, desc: true } : { by: null, desc: false }
    setSort(next)
    try {
      localStorage.setItem(LS_SORT, JSON.stringify(next))
    } catch {
      /* not remembered */
    }
  }

  /** Adds the pasted link; then loads it on a deck, on the free deck, or only keeps it. */
  const loadLink = (deck: Deck | 'free' | null) => {
    const entry = library.addLink(query)
    if (!entry) return
    if (list && !entry.list) library.setList(entry.id, list)
    if (deck === 'free') library.loadFree(entry, deckA, deckB)
    else if (deck) library.load(entry, deck)
    setSelected(entry.id)
    setQuery('')
  }

  /**
   * The best track to play next, from what is playing: same tempo and a key that mixes count most,
   * then a tempo close to it; tracks already played or on a deck are left out.
   */
  const suggest = (): Entry | null => {
    const now = new Set(Object.values(onDeck))
    let best: Entry | null = null
    let bestScore = -Infinity
    for (const e of entries) {
      if (now.has(e.id) || played.includes(e.id) || !library.playable(e)) continue
      const t = tempoOf(e)
      let score = 0
      if (tempoMatch(t, liveBpm)) score += 2
      if (harmonic(keyOf(e), liveKey)) score += 2
      if (t && liveBpm) score -= Math.min(...[1, 0.5, 2].map((k) => Math.abs((t * k) / liveBpm - 1))) * 5
      if (score > bestScore) {
        bestScore = score
        best = e
      }
    }
    return best
  }

  // Keep the selected row in view as the arrows move it.
  useEffect(() => {
    body.current?.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const move = (step: number) => {
    if (!shown.length) return
    const at = shown.findIndex((e) => e.id === selected)
    const next = at < 0 ? (step > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, at + step))
    setSelected(shown[next].id)
  }

  // The controller's browser knob and LOAD buttons: same moves as the arrows and Enter / ← / →.
  const pending = useStore(browse).pending
  useEffect(() => {
    if (!pending.length) return
    let at = shown.findIndex((e) => e.id === selected)
    for (const r of takeBrowse()) {
      if (r.step && shown.length) {
        at = at < 0 ? (r.step > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, at + r.step))
      }
      const entry = shown[at]
      if (r.load && entry && library.playable(entry)) {
        if (r.load === 'free') library.loadFree(entry, deckA, deckB)
        else library.load(entry, r.load === 'A' ? deckA : deckB)
      }
    }
    if (shown[at]) setSelected(shown[at].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  const onKeys = (e: React.KeyboardEvent) => {
    const entry = shown.find((x) => x.id === selected)
    const ready = entry && library.playable(entry)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && ready) library.loadFree(entry, deckA, deckB)
    else if (e.key === 'ArrowLeft' && ready) library.load(entry, deckA)
    else if (e.key === 'ArrowRight' && ready) library.load(entry, deckB)
    else if ((e.key === 'f' && (e.metaKey || e.ctrlKey)) || e.key === '/') {
      e.preventDefault()
      search.current?.focus()
    } else return
  }

  const arrow = (by: Column) => (sort.by === by ? (sort.desc ? ' ↓' : ' ↑') : '')
  const header = (by: Column, label: string, className = '') => (
    <th className={className} aria-sort={sort.by === by ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button className={'lib-sort' + (sort.by === by ? ' on' : '')} onClick={() => sortBy(by)}>
        {label}
        {arrow(by)}
      </button>
    </th>
  )

  const bar = (
    <div className="lib-bar">
      <label className="lib-search">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          {isLink ? (
            <path
              d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          ) : (
            <path
              d="M7 12A5 5 0 107 2a5 5 0 000 10zM10.5 10.5L14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          )}
        </svg>
        <input
          ref={search}
          type="search"
          value={query}
          placeholder="Procurar, ou colar link do YouTube / Spotify"
          aria-label="Procurar na biblioteca ou colar um link"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isLink) loadLink('free')
            if (e.key === 'Escape') setQuery('')
            if (e.key === 'ArrowDown' && !isLink) {
              e.preventDefault()
              body.current?.closest<HTMLElement>('.lib-tracks')?.focus()
              move(1)
            }
          }}
        />
      </label>
      {isLink && (
        <>
          <button className="btn load-a" onClick={() => loadLink(deckA)}>
            → A
          </button>
          <button className="btn load-b" onClick={() => loadLink(deckB)}>
            → B
          </button>
          <button className="btn" onClick={() => loadLink(null)} title="Só guardar na biblioteca">
            Guardar
          </button>
        </>
      )}
      <button className="btn" onClick={() => picker.current?.click()}>
        + Ficheiros
      </button>
      <input
        ref={picker}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) for (const added of library.addFiles(Array.from(e.target.files))) if (list) library.setList(added.id, list)
          e.target.value = ''
        }}
      />
      <button
        className="btn lib-suggest"
        disabled={!live || !entries.length}
        onClick={() => {
          const next = suggest()
          if (!next) return
          setSmart(null)
          setSelected(next.id)
          library.loadFree(next, deckA, deckB)
        }}
        title={
          live
            ? 'Carrega no deck livre a melhor música para a seguir: tempo e tom compatíveis com o deck ' +
              (live === a ? 'A' : 'B') +
              ', ainda não tocada'
            : 'Põe uma música a tocar primeiro'
        }
      >
        ✦ Sugerir
      </button>
      <span className="lib-count" title={analyzing ? 'A medir BPM e tom…' : undefined}>
        {shown.length} {shown.length === 1 ? 'música' : 'músicas'}
        {total > 0 && ' · ' + hours(total)}
        {analyzing && ' · a medir…'}
      </span>
      {(lyr.model === 'missing' || lyr.model === 'installing') && (
        <button
          className={'btn lib-ai' + (lyr.modelError ? ' err' : '')}
          disabled={lyr.model === 'installing'}
          onClick={() => void lyrics.installModel()}
          title={
            lyr.modelError
              ? 'A instalação falhou (' + lyr.modelError + '). Clica para tentar outra vez'
              : 'Descarrega uma vez o modelo de letras (' +
                lyr.modelSizeMb +
                ' MB, da Hugging Face). Depois a app transcreve sozinha, no teu Mac, as letras das músicas que o catálogo não conhece'
          }
        >
          {lyr.model === 'installing'
            ? 'A instalar letras ' + Math.round(lyr.modelProgress * 100) + '%'
            : lyr.modelError
              ? 'Letras: tentar outra vez'
              : 'Instalar letras · ' + lyr.modelSizeMb + ' MB'}
        </button>
      )}
      <label className="lib-lang" title="Língua em que as músicas são cantadas: ajuda a transcrever as letras no Mac">
        Letras
        <select value={lyr.lang} onChange={(e) => lyrics.setLang(e.target.value as LyricsLang)} aria-label="Língua das letras">
          {LYRICS_LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )

  return (
    <div className="library">
      {slot ? createPortal(bar, slot) : bar}
      {error && <p className="deck-msg error">{error}</p>}

      <div className="lib-body">
        <nav className="lib-lists" aria-label="Listas">
          <button
            className={'lib-list' + (list === null && !riddim ? ' active' : '')}
            onClick={() => {
              setList(null)
              library.showRiddim(null)
            }}
          >
            Todas <i>{entries.length}</i>
          </button>
          <h6 className="lib-smart-head" title={live ? 'Comparado com o deck ' + (live === a ? 'A' : 'B') : 'Põe uma música a tocar'}>
            Inteligentes{live ? ' · deck ' + (live === a ? 'A' : 'B') : ''}
          </h6>
          {SMART.map((m) => (
            <button
              key={m.id}
              className={'lib-list smart' + (smart === m.id ? ' active' : '')}
              aria-pressed={smart === m.id}
              disabled={(m.id === 'match' || m.id === 'tempo' || m.id === 'key') && !live}
              onClick={() => setSmart(smart === m.id ? null : m.id)}
              title={m.hint}
            >
              {m.label}
              {m.id === 'played' && <i>{played.length}</i>}
            </button>
          ))}
          <h6 className="lib-smart-head">Listas</h6>
          {lists.map((name) => (
            <div
              key={name}
              className={'lib-list' + (list === name && !riddim ? ' active' : '')}
              onDragOver={(e) => e.dataTransfer.types.includes(ENTRY_DRAG) && e.preventDefault()}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(ENTRY_DRAG)
                if (id) library.setList(id, name)
              }}
              title="Arrasta músicas para aqui para as guardar nesta lista"
            >
              <button
                onClick={() => {
                  setList(name)
                  library.showRiddim(null)
                }}
              >
                {name} <i>{entries.filter((e) => e.list === name).length}</i>
              </button>
              <button
                className="lib-list-del"
                aria-label={'Apagar lista ' + name}
                title="Apagar lista (as músicas ficam na biblioteca)"
                onClick={() => {
                  if (list === name) setList(null)
                  library.removeList(name)
                }}
              >
                ×
              </button>
            </div>
          ))}
          {naming === null ? (
            <button className="lib-list new" onClick={() => setNaming('')}>
              + Lista
            </button>
          ) : (
            <input
              className="lib-list-name"
              autoFocus
              value={naming}
              placeholder="Nome da lista"
              aria-label="Nome da nova lista"
              onChange={(e) => setNaming(e.target.value)}
              onBlur={() => setNaming(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && naming.trim()) {
                  library.addList(naming)
                  setList(naming.trim())
                  setNaming(null)
                }
                if (e.key === 'Escape') setNaming(null)
              }}
            />
          )}
          {/* Riddims: found by listening, nothing to set up. (Set aside for now.) */}
          {RIDDIMS_ON && (
            <>
              <h6 className="lib-riddims-head" title="Versões do mesmo instrumental, encontradas pela app ao ouvir as tuas músicas">
                Riddims
              </h6>
              {riddims.length === 0 ? (
                <p className="lib-riddims-hint">
                  {analyzing ? 'A ouvir as músicas…' : 'Aparecem aqui sozinhos quando tiveres várias versões do mesmo instrumental.'}
                </p>
              ) : (
                riddims.map((r) => (
                  <button
                    key={r.key}
                    className={'lib-list riddim' + (riddimView === r.key ? ' active' : '')}
                    onClick={() => library.showRiddim(r.key)}
                    title={'Ver as ' + r.members.length + ' versões deste riddim'}
                  >
                    {r.name} <i>{r.members.length}</i>
                  </button>
                ))
              )}
            </>
          )}
        </nav>

        <div
          className="lib-tracks"
          tabIndex={0}
          onKeyDown={onKeys}
          aria-label="Músicas. Setas: escolher; Enter: carregar; ← deck A; → deck B"
        >
          {riddim && (
            <div className="lib-riddim-bar">
              {renaming === null ? (
                <b onDoubleClick={() => setRenaming(riddim.name)} title="Duplo clique para mudar o nome">
                  {riddim.name}
                </b>
              ) : (
                <input
                  autoFocus
                  value={renaming}
                  aria-label="Nome do riddim"
                  onChange={(e) => setRenaming(e.target.value)}
                  onBlur={() => {
                    library.renameRiddim(riddim.key, renaming)
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              )}
              <span title="Toca-as uma a seguir à outra. Se alguma não for deste riddim, tira-a com ×.">
                {riddim.members.length} versões do mesmo instrumental: toca-as uma a seguir à outra. Se alguma não for deste riddim, tira-a
                com ×.
              </span>
              <button className="btn small" onClick={() => setRenaming(riddim.name)}>
                Mudar nome
              </button>
              <button className="btn small" onClick={() => library.showRiddim(null)}>
                Voltar
              </button>
            </div>
          )}
          {shown.length === 0 ? (
            <p className="empty">
              {entries.length === 0
                ? 'Biblioteca vazia. Arrasta ficheiros de áudio para a janela, ou cola um link na caixa de procura, ao lado das abas.'
                : words.length
                  ? 'Nada encontrado para "' + query.trim() + '".'
                  : 'Lista vazia. Arrasta músicas para o nome da lista, à esquerda.'}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="c-mark" aria-label="No deck" />
                  {header('title', 'Título', 'c-title')}
                  {header('artist', 'Artista', 'c-artist')}
                  {header('bpm', 'BPM', 'c-num')}
                  {header('key', 'Tom', 'c-key')}
                  {header('duration', 'Tempo', 'c-num')}
                  {list === null && <th className="c-list">Lista</th>}
                  {header('kind', 'Origem', 'c-kind')}
                  <th className="c-act" aria-label="Ações" />
                </tr>
              </thead>
              <tbody ref={body}>
                {shown.map((entry) => {
                  const stale = !library.playable(entry)
                  const ref = entry.kind === 'local' ? null : entry.kind + ':' + entry.ref
                  const measuring = analyzing === entry.id
                  const t = tempoOf(entry)
                  let tempo = t ? t.toFixed(1) : measuring ? '…' : '—'
                  if (!t && ref && (bpm.looking.includes(ref) || bpm.current === ref)) tempo = '…'
                  const key = keyOf(entry)
                  const deckOn = (['A', 'B'] as const).filter((n) => onDeck[n] === entry.id && (n === 'A' ? a : b).kind !== 'none')
                  const bpmFit = !deckOn.length && tempoMatch(t, liveBpm)
                  const keyFit = !deckOn.length && harmonic(key, liveKey)
                  return (
                    <tr
                      key={entry.id}
                      className={[
                        initial.current.has(entry.id) ? '' : 'fresh',
                        stale ? 'stale' : '',
                        selected === entry.id ? 'sel' : '',
                        played.includes(entry.id) && !deckOn.length ? 'played' : '',
                      ].join(' ')}
                      draggable={!stale}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(ENTRY_DRAG, entry.id)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      onClick={() => setSelected(entry.id)}
                      onDoubleClick={() => !stale && library.loadFree(entry, deckA, deckB)}
                      title={stale ? 'Ficheiro sem caminho conhecido: volta a adicioná-lo' : undefined}
                    >
                      <td className="c-mark">
                        {deckOn.map((n) => (
                          <i key={n} className={'on-deck ' + n.toLowerCase()} title={'No deck ' + n}>
                            {n}
                          </i>
                        ))}
                      </td>
                      <td
                        className={'c-title' + (!riddim && library.riddimOf(entry.id) ? ' has-riddim' : '')}
                        title={entry.title + (entry.artist ? ' · ' + entry.artist : '')}
                      >
                        {entry.title}
                        {/* Shown here only when the table is too narrow for its own Artist column. */}
                        {entry.artist && <span className="t-artist"> · {entry.artist}</span>}
                        {!riddim && library.riddimOf(entry.id) && (
                          <button
                            className="lib-riddim-chip"
                            onClick={(e) => {
                              e.stopPropagation()
                              library.showRiddim(library.riddimOf(entry.id)!.key)
                            }}
                            title={'Faz parte de "' + library.riddimOf(entry.id)!.name + '": ver as outras versões'}
                          >
                            riddim · {library.riddimOf(entry.id)!.members.length}
                          </button>
                        )}
                        {riddim && (
                          <button
                            className="lib-riddim-chip out"
                            onClick={(e) => {
                              e.stopPropagation()
                              library.leaveRiddim(entry.id)
                            }}
                            title="Não é deste riddim: tirar daqui"
                          >
                            ×
                          </button>
                        )}
                        {words.length > 0 && !words.every((w) => (entry.title + ' ' + entry.artist).toLowerCase().includes(w)) && (
                          <em className="lib-sung" title="Encontrada na letra">
                            na letra
                          </em>
                        )}
                      </td>
                      <td className="c-artist">{entry.artist || <span className="none">—</span>}</td>
                      <td
                        className={'c-num' + (bpmFit ? ' fit' : '')}
                        title={bpmFit ? 'Tempo próximo do deck que está a tocar' : undefined}
                      >
                        {tempo}
                      </td>
                      <td
                        className={'c-key' + (keyFit ? ' fit' : '')}
                        title={keyFit ? 'Tom compatível com o deck que está a tocar' : (key ?? undefined)}
                      >
                        {key ? camelot(key) : measuring ? '…' : '—'}
                        {key && <small>{key}</small>}
                      </td>
                      <td className="c-num">{entry.duration ? clock(entry.duration) : measuring ? '…' : '—'}</td>
                      {list === null && (
                        <td className="c-list">
                          <select
                            className="lib-move"
                            value={entry.list ?? ''}
                            aria-label={'Lista de ' + entry.title}
                            onChange={(e) => library.setList(entry.id, e.target.value || undefined)}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="">—</option>
                            {lists.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td className="c-kind">
                        <em className={'kind ' + entry.kind} title={KIND_LABEL[entry.kind]}>
                          {KIND_MARK[entry.kind]}
                        </em>
                      </td>
                      <td className="c-act">
                        <button
                          className="row-btn a"
                          disabled={stale}
                          onClick={() => library.load(entry, deckA)}
                          aria-label={'Carregar no deck A: ' + entry.title}
                        >
                          A
                        </button>
                        <button
                          className="row-btn b"
                          disabled={stale}
                          onClick={() => library.load(entry, deckB)}
                          aria-label={'Carregar no deck B: ' + entry.title}
                        >
                          B
                        </button>
                        <button
                          className="row-btn x"
                          onClick={() => library.remove(entry.id)}
                          aria-label={'Remover da biblioteca: ' + entry.title}
                          title="Remover da biblioteca"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
