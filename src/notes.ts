import { Store } from './store'
import { decks } from './engine/deck'
import { library } from './library'

/**
 * Set notes: the DJ's own text (the plan for the set, reminders, shout-outs), kept between sessions.
 * Lines that start with "- " are the set list: each one is ticked by itself once a track whose title
 * it names has been played on a deck.
 */
export interface NotesState {
  text: string
  open: boolean
}

const LS = 'vx_set_notes'

function savedText(): string {
  try {
    return localStorage.getItem(LS) ?? ''
  } catch {
    return ''
  }
}

class Notes extends Store<NotesState> {
  constructor() {
    super({ text: savedText(), open: false })
  }

  setText(text: string): void {
    this.set({ text })
    try {
      localStorage.setItem(LS, text)
    } catch {
      /* kept for this session only */
    }
  }

  toggle(open = !this.state.open): void {
    this.set({ open })
  }
}

export const notes = new Notes()

/** Lower case, no accents, no "(official video)" or punctuation: what two ways of writing a title share. */
export function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Titles played on a deck this session (library history and what is on the decks now, if it played). */
export function playedTitles(): string[] {
  const lib = library.get()
  const titles = lib.played.map((id) => library.byId(id)?.title ?? '').filter(Boolean)
  for (const d of decks) {
    const s = d.get()
    if (s.title && (s.playing || d.getPosition() > 1)) titles.push(s.title)
  }
  return titles.map(normalise).filter((t) => t.length > 2)
}

/** A set-list line counts as played when its words (3+ letters) all appear in a played title, or the other way round. */
export function linePlayed(line: string, played: string[]): boolean {
  const l = normalise(line.replace(/^\s*-\s*/, ''))
  if (l.length < 3) return false
  return played.some((t) => t.includes(l) || l.includes(t))
}
