import { Store } from './store'
import { mixer } from './engine/mixer'
import { decks, type Deck } from './engine/deck'
import { STEMS } from './engine/stems'
import { PADS, sampler } from './engine/sampler'
import { dubBox } from './engine/dubbox'
import { MOVES, moves, type Move } from './engine/moves'
import { browseLoad, browseStep } from './browse'
import { padModes, samplerBase } from './padmode'
import { sirenKeys } from './engine/sirenkeys'
import { liveDeck, outboard } from './engine/outboard'
import { autoDub } from './engine/autodub'
import { isolator } from './engine/isolator'
import { mic } from './engine/mic'
import { ui } from './ui'

/**
 * button: fires on press · hold: 1 on press, 0 on release · fader: 0..1 ·
 * center: -1..1 (centre detent) · jog: relative ticks
 */
export type ActionType = 'button' | 'hold' | 'fader' | 'center' | 'jog'

export interface Action {
  id: string
  label: string
  group: string
  type: ActionType
  run(value: number): void
}

/** The pitch range chosen on screen for a deck (8, 16 or 50 %). */
function pitchRange(name: string): number {
  try {
    const r = Number(localStorage.getItem('vx_pitch_range_' + name))
    return [8, 16, 50].includes(r) ? r : 8
  } catch {
    return 8
  }
}

function deckActions(deck: Deck, other: Deck): Action[] {
  const p = 'deck' + deck.name + '.'
  const group = 'Deck ' + deck.name
  const a = (id: string, label: string, type: ActionType, run: (v: number) => void): Action => ({
    id: p + id,
    label,
    group,
    type,
    run,
  })
  return [
    a('play', 'Play / Pausa', 'button', () => deck.toggle()),
    a('cue', 'Cue', 'button', () => deck.cue()),
    a('sync', 'Sync', 'button', () => deck.sync(other)),
    a('pfl', 'Pré-escuta (auscultadores)', 'button', () => deck.togglePfl()),
    ...[0, 1, 2, 3].map((i) => a('hotcue' + (i + 1), 'Hot cue ' + (i + 1), 'button', () => deck.hotcue(i))),
    ...[1, 2, 4, 8].map((b) => a('loop' + b, 'Loop ' + b, 'button', () => deck.toggleLoop(b))),
    a('volume', 'Volume', 'fader', (v) => deck.setVolume(v)),
    // Same range as the deck's ±8 / 16 / 50 button; down is faster, like on screen.
    a('pitch', 'Pitch (fader, alcance do deck)', 'center', (v) => deck.setRate(1 + (v * pitchRange(deck.name)) / 100)),
    a('pitchUp', 'Pitch + (botão)', 'button', () => deck.stepRate(1)),
    a('pitchDown', 'Pitch − (botão)', 'button', () => deck.stepRate(-1)),
    a('pitchReset', 'Pitch a zero', 'button', () => deck.setRate(1)),
    a('bendUp', 'Pitch bend + (manter)', 'hold', (v) => deck.setBend(v ? 1.04 : 1)),
    a('bendDown', 'Pitch bend − (manter)', 'hold', (v) => deck.setBend(v ? 0.96 : 1)),
    a('high', 'EQ agudos', 'center', (v) => deck.setEq('high', v)),
    a('mid', 'EQ médios', 'center', (v) => deck.setEq('mid', v)),
    a('low', 'EQ graves', 'center', (v) => deck.setEq('low', v)),
    a('filter', 'Filtro', 'center', (v) => deck.setFilter(v)),
    a('gain', 'Ganho', 'center', (v) => deck.setGain(v)),
    a('keylock', 'Key lock', 'button', () => deck.toggleKeyLock()),
    a('loopIn', 'Loop manual: início', 'button', () => deck.loopIn()),
    a('loopOut', 'Loop manual: fim / sair', 'button', () => deck.loopOut()),
    a('loopHalf', 'Loop ½', 'button', () => deck.loopScale(0.5)),
    a('loopDouble', 'Loop ×2', 'button', () => deck.loopScale(2)),
    a('dub', 'Dub', 'hold', (v) => deck.dubPress(v > 0)),
    a('rewind', 'Rewind (pull up)', 'button', () => deck.rewind()),
    a('fxOn', 'Efeito ligar / desligar', 'button', () => deck.toggleFx()),
    a('fxAmount', 'Efeito quantidade', 'fader', (v) => deck.setFxAmount(v)),
    ...STEMS.map((st) => a('stem.' + st, 'Stem ' + st, 'button', () => deck.toggleStem(st))),
    a('jog', 'Jog wheel', 'jog', (v) => deck.jog(v)),
    a('vinyl', 'VINYL: modo vinil do jog (ligar / desligar)', 'button', () => {
      vinyl[deck.name as 'A' | 'B'] = !vinyl[deck.name as 'A' | 'B']
      midi.queueLeds()
    }),
    // Top of the platter: scratches in vinyl mode, nudges otherwise. The ring always nudges ("jog").
    // The top sends about three times more ticks per turn than the screen's platter: scaled so a turn is a turn.
    a('jogTop', 'Jog: em cima do prato', 'jog', (v) => (vinyl[deck.name as 'A' | 'B'] ? deck.scratch(v * 0.32) : deck.jog(v * 0.32))),
    a('jogTouch', 'Jog: mão no prato (vinil)', 'hold', (v) => vinyl[deck.name as 'A' | 'B'] && deck.jogTouch(v > 0)),
    a('shift', 'SHIFT (manter)', 'hold', () => undefined), // read by the MIDI handler, not an action of its own
    // Pads that follow the deck's pad mode (CUE / LOOP / STEMS), and their second function.
    ...[0, 1, 2, 3].map((i) => a('pad' + (i + 1), 'Pad ' + (i + 1) + ' (segue o modo)', 'button', () => pad(deck, i, false))),
    ...[0, 1, 2, 3].map((i) => a('padAlt' + (i + 1), 'Pad ' + (i + 1) + ' 2.ª função', 'button', () => pad(deck, i, true))),
    a('padModeNext', 'Modo dos pads: seguinte', 'button', () => padModes.step(deck.name as 'A' | 'B', 1)),
    a('padModePrev', 'Modo dos pads: anterior', 'button', () => padModes.step(deck.name as 'A' | 'B', -1)),
    a('padModeCue', 'Modo dos pads: CUE', 'button', () => padModes.setMode(deck.name as 'A' | 'B', 'cue')),
    a('padModeLoop', 'Modo dos pads: LOOP', 'button', () => padModes.setMode(deck.name as 'A' | 'B', 'loop')),
    a('padModeStems', 'Modo dos pads: STEMS', 'button', () => padModes.setMode(deck.name as 'A' | 'B', 'stems')),
    a('padModeSampler', 'Modo dos pads: SAMPLER', 'button', () => padModes.setMode(deck.name as 'A' | 'B', 'sampler')),
  ]
}

/**
 * A pad, by the deck's pad mode. CUE: hot cue (2nd: delete it). LOOP: 4 beats, 8 beats, in, out
 * (2nd: ½, ×2, 1 beat, 16 beats). STEMS: voice, instruments, bass, kick on / off (2nd: hear only that part).
 * SAMPLER: sampler pads 1-4 on deck A, 5-8 on deck B (2nd: stop it).
 */
function pad(deck: Deck, i: number, alt: boolean): void {
  const mode = padModes.get()[deck.name as 'A' | 'B']
  if (mode === 'cue') return alt ? deck.clearHotcue(i) : deck.hotcue(i)
  if (mode === 'loop') {
    if (alt) return [() => deck.loopScale(0.5), () => deck.loopScale(2), () => deck.toggleLoop(1), () => deck.toggleLoop(16)][i]()
    return [() => deck.toggleLoop(4), () => deck.toggleLoop(8), () => deck.loopIn(), () => deck.loopOut()][i]()
  }
  if (mode === 'sampler') {
    const slot = samplerBase(deck.name) + i
    return alt ? sampler.stop(slot) : sampler.trigger(slot)
  }
  const stem = STEMS[i]
  if (alt) deck.soloStem(stem)
  else deck.toggleStem(stem)
}

/** The rack's tape echo, spring and weight. */
function rackActions(): Action[] {
  const a = (id: string, label: string, type: ActionType, run: (v: number) => void): Action => ({
    id: 'rack.' + id,
    label,
    group: 'Rack',
    type,
    run,
  })
  return [
    a('throwA', 'Eco de fita: THROW A (manter)', 'hold', (v) => outboard.throw('A', v > 0)),
    a('throwB', 'Eco de fita: THROW B (manter)', 'hold', (v) => outboard.throw('B', v > 0)),
    a('echoFeedback', 'Eco de fita: REPETIR', 'fader', (v) => outboard.update({ feedback: v * 1.1 })),
    a('echoTone', 'Eco de fita: TOM', 'fader', (v) => outboard.update({ tone: v })),
    a('echoWobble', 'Eco de fita: FITA', 'fader', (v) => outboard.update({ wobble: v })),
    a('spring', 'Eco de fita: MOLA', 'fader', (v) => outboard.update({ spring: v })),
    a('echoLevel', 'Eco de fita: NÍVEL', 'fader', (v) => outboard.update({ echoLevel: v })),
    a('crash', 'Pancada na mola', 'button', () => outboard.crash()),
    a('weight', 'PESO (sub-grave)', 'fader', (v) => outboard.update({ weight: v })),
    a('drop', 'DROP', 'button', () => outboard.drop()),
    a('autodub', 'DUB AUTO: ligar / desligar', 'button', () => autoDub.toggle()),
    a('tap', 'Eco de fita: TAP (tempo à mão)', 'button', () => outboard.tap()),
    a('echoTime', 'Eco de fita: TEMPO (à mão)', 'fader', (v) => outboard.setManualTime(0.05 + v * 1.15)),
    a('sendA', 'Eco de fita: ENVIO A', 'fader', (v) => outboard.setSend('A', v)),
    a('sendB', 'Eco de fita: ENVIO B', 'fader', (v) => outboard.setSend('B', v)),
    // Isolator (whole master)
    a('isoLow', 'Isolator: GRAVES', 'fader', (v) => isolator.update({ low: v * 1.5 })),
    a('isoMid', 'Isolator: MÉDIOS', 'fader', (v) => isolator.update({ mid: v * 1.5 })),
    a('isoTop', 'Isolator: AGUDOS', 'fader', (v) => isolator.update({ top: v * 1.5 })),
    a('killLow', 'Isolator: KILL graves', 'button', () => isolator.kill('low', !isolator.get().killLow)),
    a('killMid', 'Isolator: KILL médios', 'button', () => isolator.kill('mid', !isolator.get().killMid)),
    a('killTop', 'Isolator: KILL agudos', 'button', () => isolator.kill('top', !isolator.get().killTop)),
    // Microphone
    a('talk', 'Microfone: FALAR (ligar / desligar)', 'button', () => mic.setTalk(!mic.get().talk)),
    a('talkHold', 'Microfone: FALAR enquanto premido', 'hold', (v) => mic.setTalk(v > 0)),
    a('micLevel', 'Microfone: NÍVEL', 'fader', (v) => mic.update({ level: v * 1.5 })),
  ]
}

function dubBoxActions(): Action[] {
  const a = (id: string, label: string, type: ActionType, run: (v: number) => void): Action => ({
    id: 'dubbox.' + id,
    label,
    group: 'Dub Box',
    type,
    run,
  })
  const log = (v: number, lo: number, hi: number): number => lo * Math.pow(hi / lo, v)
  return [
    a('fire', 'Disparar (FIRE)', 'hold', (v) => dubBox.fire(v > 0)),
    a('throw', 'Throw para o eco (manter)', 'hold', (v) => dubBox.throw(v > 0)),
    a('level', 'Volume do canal', 'fader', (v) => dubBox.setLevel(v)),
    a('filter', 'Filtro', 'center', (v) => dubBox.setFilter(v)),
    a('pitch', 'Tom', 'fader', (v) => dubBox.updatePatch({ pitch: log(v, 60, 3000) })),
    a('lfoRate', 'Velocidade da oscilação', 'fader', (v) => dubBox.updatePatch({ lfoRate: log(v, 0.1, 20) })),
    a('lfoDepth', 'Profundidade da oscilação', 'fader', (v) => dubBox.updatePatch({ lfoDepth: v * 24 })),
    a('echo', 'Eco (envio)', 'fader', (v) => dubBox.updatePatch({ echo: v })),
    a('feedback', 'Eco (repetições)', 'fader', (v) => dubBox.updatePatch({ feedback: v * 0.95 })),
    a('pfl', 'Pré-escuta (auscultadores)', 'button', () => dubBox.togglePfl()),
    ...[0, 1, 2, 3].map((i) => a('slot' + (i + 1), 'Botão rápido ' + (i + 1), 'hold', (v) => dubBox.fireSlot(i, v > 0))),
    // The sound the keyboard (and FIRE) plays: one of the 4 quick buttons, without firing it.
    ...[0, 1, 2, 3].map((i) =>
      a('pick' + (i + 1), 'Escolher o som do botão rápido ' + (i + 1), 'button', () => {
        const slot = dubBox.get().slots[i]
        if (!slot) return
        dubBox.usePreset(slot.name)
        if (dubBox.get().preset !== slot.name) dubBox.updatePatch({ ...slot.patch })
      }),
    ),
    a('surprise', 'Surpresa', 'button', () => dubBox.surprise()),
    a('next', 'Predefinição seguinte', 'button', () => dubBox.stepPreset(1)),
    a('prev', 'Predefinição anterior', 'button', () => dubBox.stepPreset(-1)),
  ]
}

/** 8 beats of the deck that is playing, else 4 seconds (same rule as the A / B buttons of the mixer). */
function eightBeats(): number {
  const playing = decks.map((d) => d.get()).find((d) => d.playing && d.bpm)
  return playing?.bpm ? Math.min(12, Math.max(2, (8 * 60) / (playing.bpm * playing.rate))) : 4
}

/** The deck waiting to come in follows the one the crowd hears (tempo and beat), like SYNC pressed on it. */
function beatmatch(): void {
  const live = liveDeck()
  if (!live) return
  const incoming = decks.find((d) => d !== live)!
  if (!incoming.get().syncOn) incoming.sync(live)
}

export const actions: Action[] = [
  { id: 'mixer.crossfader', label: 'Crossfader', group: 'Mixer', type: 'fader', run: (v) => mixer.setCrossfader(v) },
  { id: 'mixer.fadeA', label: 'Passar para A (8 batidas)', group: 'Mixer', type: 'button', run: () => mixer.autoFade(0, eightBeats()) },
  { id: 'mixer.fadeB', label: 'Passar para B (8 batidas)', group: 'Mixer', type: 'button', run: () => mixer.autoFade(1, eightBeats()) },
  {
    id: 'mixer.cueMaster',
    label: 'Master nos auscultadores (ligar / desligar)',
    group: 'Mixer',
    type: 'button',
    run: () => mixer.setCueMix(mixer.get().cueMix > 0.5 ? 0 : 1),
  },
  { id: 'mixer.beatmatch', label: 'Beatmatch: sincronizar o deck que vai entrar', group: 'Mixer', type: 'button', run: () => beatmatch() },
  { id: 'mixer.master', label: 'Master', group: 'Mixer', type: 'fader', run: (v) => mixer.setMaster(v) },
  { id: 'mixer.hpVolume', label: 'Volume auscultadores', group: 'Mixer', type: 'fader', run: (v) => mixer.setHeadphoneVolume(v) },
  { id: 'mixer.rec', label: 'Gravar / parar', group: 'Mixer', type: 'button', run: () => mixer.toggleRecording() },
  { id: 'mixer.cueMix', label: 'Mistura cue / master', group: 'Mixer', type: 'fader', run: (v) => mixer.setCueMix(v) },
  { id: 'browser.open', label: 'Abrir a biblioteca', group: 'Browser', type: 'button', run: () => ui.open('library') },
  { id: 'browser.scroll', label: 'Rodar (mexe a seleção)', group: 'Browser', type: 'jog', run: (v) => browseStep(Math.sign(v)) },
  { id: 'browser.down', label: 'Seleção para baixo', group: 'Browser', type: 'button', run: () => browseStep(1) },
  { id: 'browser.up', label: 'Seleção para cima', group: 'Browser', type: 'button', run: () => browseStep(-1) },
  { id: 'browser.pageDown', label: 'Descer 10', group: 'Browser', type: 'button', run: () => browseStep(10) },
  { id: 'browser.pageUp', label: 'Subir 10', group: 'Browser', type: 'button', run: () => browseStep(-10) },
  { id: 'browser.loadA', label: 'Carregar no deck A', group: 'Browser', type: 'button', run: () => browseLoad('A') },
  { id: 'browser.loadB', label: 'Carregar no deck B', group: 'Browser', type: 'button', run: () => browseLoad('B') },
  { id: 'browser.loadFree', label: 'Carregar no deck livre', group: 'Browser', type: 'button', run: () => browseLoad('free') },
  ...dubBoxActions(),
  ...rackActions(),
  ...(Object.keys(MOVES) as Move[]).map((m): Action => ({
    id: 'moves.' + m,
    label: MOVES[m].label,
    group: 'Transições',
    type: 'button',
    run: () => moves.run(m),
  })),
  ...deckActions(decks[0], decks[1]),
  ...deckActions(decks[1], decks[0]),
  ...Array.from({ length: PADS }, (_, i): Action => ({
    id: 'sampler.pad' + (i + 1),
    label: 'Sample ' + (i + 1),
    group: 'Sampler',
    type: 'button',
    run: () => sampler.trigger(i),
  })),
]
const actionById = new Map(actions.map((a) => [a.id, a]))

/**
 * Factory mapping for Hercules DJControl Inpulse 200/300 (codes taken from the Mixxx mappings).
 * Deck A = MIDI channel 2, deck B = channel 3, pads on channels 7/8, crossfader on channel 1.
 * The Inpulse 200 has no mid EQ knob; that entry is simply never triggered there.
 */
function herculesInpulse(): Record<string, string> {
  const map: Record<string, string> = { 'c:0:0': 'mixer.crossfader' }
  const sides: [string, number, number][] = [
    ['deckA.', 1, 6],
    ['deckB.', 2, 7],
  ]
  for (const [p, ch, pads] of sides) {
    map[`n:${ch}:7`] = p + 'play'
    map[`n:${ch}:6`] = p + 'cue'
    map[`n:${ch}:5`] = p + 'sync'
    map[`n:${ch}:12`] = p + 'pfl'
    map[`c:${ch}:0`] = p + 'volume'
    map[`c:${ch}:1`] = p + 'filter'
    map[`c:${ch}:2`] = p + 'low'
    map[`c:${ch}:3`] = p + 'mid'
    map[`c:${ch}:4`] = p + 'high'
    map[`c:${ch}:8`] = p + 'pitch' // coarse byte of the 14-bit fader
    map[`c:${ch}:9`] = p + 'jog' // outer ring
    map[`c:${ch}:10`] = p + 'jog' // touch surface
    for (let i = 0; i < 4; i++) {
      map[`n:${pads}:${i}`] = p + 'hotcue' + (i + 1)
      map[`n:${pads}:${16 + i}`] = p + 'loop' + [1, 2, 4, 8][i]
    }
  }
  return map
}

/**
 * Hercules DJControl Inpulse 200 MK2, from the controller's own messages (recorded control by control):
 * mixer on MIDI channel 1, deck A on 2, deck B on 3, pads on 7 / 8. Faders send 14 bits (CC n and n+32);
 * the coarse byte is enough. Two-band EQ (bass, treble) plus filter and gain. Jogs: ring CC 9, top CC 10 (scratch in VINYL mode),
 * relative (1 = forward, 127 = back). Lights answer on the same channel and note (127 on, 0 off).
 */
function herculesInpulse200Mk2(): Record<string, string> {
  const map: Record<string, string> = {
    'c:0:0': 'mixer.crossfader',
    // Browser (recorded): knob turns CC 1 (1 = down, 127 = up); LOAD A / B are note 13 of each deck.
    'c:0:1': 'browser.scroll',
    'n:0:0': 'browser.open', // BROWSER
    'n:0:3': 'browser.loadFree', // ASSIST / PREP: the selected track ready on the free deck
    'n:0:2': 'mixer.cueMaster', // MASTER (headphones hear the master)
    'n:0:1': 'mixer.beatmatch', // BEATMATCH GUIDE
    'n:1:13': 'browser.loadA',
    'n:2:13': 'browser.loadB',
    // MASTER and HEADPHONES knobs (14-bit).
    'c:0:3': 'mixer.master',
    'c:0:4': 'mixer.hpVolume',
  }
  const sides: [string, number, number][] = [
    ['deckA.', 1, 6],
    ['deckB.', 2, 7],
  ]
  for (const [p, ch, pads] of sides) {
    map[`n:${ch}:7`] = p + 'play'
    map[`n:${ch}:6`] = p + 'cue'
    map[`n:${ch}:5`] = p + 'sync'
    map[`n:${ch}:12`] = p + 'pfl'
    map[`c:${ch}:0`] = p + 'volume'
    map[`c:${ch}:1`] = p + 'filter'
    map[`c:${ch}:2`] = p + 'low'
    map[`c:${ch}:4`] = p + 'high'
    map[`c:${ch}:5`] = p + 'gain'
    map[`c:${ch}:8`] = p + 'pitch'
    map[`c:${ch}:9`] = p + 'jog'
    map[`c:${ch}:10`] = p + 'jogTop'
    map[`n:${ch}:8`] = p + 'jogTouch' // touch sensor on top of the platter
    map[`n:${ch}:4`] = p + 'shift'
    map[`n:${ch}:3`] = p + 'vinyl'
    map[`n:${ch}:9`] = p + 'loopIn'
    map[`n:${ch}:10`] = p + 'loopOut'
    // Pads follow the on-screen pad mode; with SHIFT the controller sends them 8 notes higher (2nd function).
    for (let i = 0; i < 4; i++) {
      map[`n:${pads}:${i}`] = p + 'pad' + (i + 1)
      map[`n:${pads}:${i + 8}`] = p + 'padAlt' + (i + 1)
    }
    // Pad mode buttons: HOT CUE (with SHIFT: LOOP) and STEMS (with SHIFT: SAMPLER).
    map[`n:${ch}:15`] = p + 'padModeCue'
    map[`s:n:${ch}:15`] = p + 'padModeLoop'
    map[`n:${ch}:16`] = p + 'padModeStems'
    map[`s:n:${ch}:16`] = p + 'padModeSampler'
    // SHIFT + …: rewind on PLAY (pull up!), pitch to zero on CUE, key lock on SYNC, dub throw on the headphones button.
    map[`s:n:${ch}:7`] = p + 'rewind'
    map[`s:n:${ch}:6`] = p + 'pitchReset'
    map[`s:n:${ch}:5`] = p + 'keylock'
    map[`s:n:${ch}:12`] = p + 'dub'
  }
  return map
}

/** A preset either maps the main controller (plain keys) or one named device ("d:<device>|…" keys) alongside it. */
export const presets: { name: string; match?: RegExp; device?: string; build(): Record<string, string> }[] = [
  {
    // Any key plays the Dub Box siren as notes; the pitch wheel bends it, the modulation wheel wobbles it.
    // Kept to its own mappings, so its channel 1 never moves the Hercules mixer.
    name: 'M-Audio O2: sirene e dub',
    device: 'USB O2',
    build: () => {
      const d = 'd:USB O2|'
      return {
        [d + 'keys']: 'dubbox.keys',
        [d + 'only']: 'device.only',
        // Knobs 1-8 (as recorded) and the slider.
        [d + 'c:0:73']: 'dubbox.lfoRate',
        [d + 'c:0:72']: 'dubbox.echo',
        [d + 'c:0:74']: 'dubbox.filter',
        [d + 'c:0:71']: 'dubbox.level',
        [d + 'c:0:84']: 'rack.echoFeedback',
        [d + 'c:0:5']: 'rack.echoTone',
        [d + 'c:0:93']: 'rack.spring',
        [d + 'c:0:10']: 'rack.weight',
        [d + 'c:0:7']: 'rack.echoLevel',
        // Program buttons 1-8 (they also send a bank select, ignored).
        [d + 'g:0:0']: 'dubbox.pick1',
        [d + 'g:0:1']: 'dubbox.pick2',
        [d + 'g:0:2']: 'dubbox.pick3',
        [d + 'g:0:3']: 'dubbox.pick4',
        [d + 'g:0:4']: 'rack.crash',
        [d + 'g:0:5']: 'rack.drop',
        [d + 'g:0:6']: 'moves.echoOut',
        [d + 'g:0:7']: 'dubbox.surprise',
        [d + 'c:0:0']: 'ignore',
        [d + 'c:0:32']: 'ignore',
      }
    },
  },
  { name: 'Hercules DJControl Inpulse 200 MK2', match: /Inpulse 200 Mk ?2/i, build: herculesInpulse200Mk2 },
  { name: 'Hercules DJControl Inpulse 200 / 300', build: herculesInpulse },
]

export interface MidiState {
  supported: boolean
  connected: boolean
  inputs: string[]
  mappings: Record<string, string> // midi key → action id
  learning: string | null // action id waiting for a control
  last: string | null
  error: string | null
}

const LS_MAP = 'vx_midi_map'
const LS_ON = 'vx_midi_on'
const LS_APPLIED = 'vx_midi_applied'

/** Same mapping, same text: keys in a fixed order. */
const sorted = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))

function loadMappings(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_MAP) || '{}')
  } catch {
    return {}
  }
}

/** Human-readable name for a mapping key such as "n:0:36" or "c:1:7". */
export function describeKey(key: string): string {
  const device = key.match(/^d:([^|]*)\|(.*)$/)
  if (device) return device[1] + ' · ' + describeKey(device[2])
  if (key.startsWith('s:')) return 'SHIFT + ' + describeKey(key.slice(2))
  const [type, ch, num] = key.split(':')
  const channel = 'ch' + (Number(ch) + 1)
  if (type === 'n') return 'Nota ' + num + ' ' + channel
  if (type === 'g') return 'Programa ' + (Number(num) + 1) + ' ' + channel
  if (type === 'c') return 'CC ' + num + ' ' + channel
  return 'Pitch bend ' + channel
}

/** SHIFT held on each deck of the controller. */
const shiftHeld = { A: false, B: false }
/** VINYL mode of each deck's jog (on by default, as on the controller). */
const vinyl = { A: true, B: true }

/**
 * Whether the light of a button mapped to `id` should be on now. 0.5 = blinking (a loaded deck waiting to play).
 */
function ledFor(id: string): number {
  const deck = decks.find((d) => id.startsWith('deck' + d.name + '.'))
  if (deck) {
    const s = deck.get()
    const what = id.slice(6)
    if (what === 'play') return s.playing ? 1 : s.kind !== 'none' ? 0.5 : 0
    if (what === 'cue') return deck.atCue ? 1 : 0
    if (what === 'sync') return s.syncOn ? 1 : 0
    if (what === 'pfl') return s.pfl ? 1 : 0
    if (what.startsWith('hotcue')) return s.hotcues[Number(what.slice(6)) - 1] != null ? 1 : 0
    if (/^loop\d+$/.test(what)) return s.loop?.beats === Number(what.slice(4)) ? 1 : 0
    if (what === 'keylock') return s.keyLock || s.kind === 'youtube' ? 1 : 0
    if (what === 'fxOn') return s.fxOn ? 1 : 0
    if (what === 'dub') return s.dubbing ? 1 : 0
    if (what.startsWith('stem.')) return s.stems[what.slice(5) as keyof typeof s.stems] ? 1 : 0
    if (what === 'shift') return shiftHeld[deck.name as 'A' | 'B'] ? 1 : 0
    if (what === 'vinyl') return vinyl[deck.name as 'A' | 'B'] ? 1 : 0
    if (what === 'loopIn') return s.loopIn !== null || s.loop ? 1 : 0
    if (what === 'loopOut') return s.loop ? 1 : 0
    if (/^pad\d$/.test(what)) {
      const i = Number(what.slice(3)) - 1
      const mode = padModes.get()[deck.name as 'A' | 'B']
      if (mode === 'cue') return s.hotcues[i] != null ? 1 : 0
      if (mode === 'loop') return i < 2 ? (s.loop?.beats === [4, 8][i] ? 1 : 0) : i === 2 ? (s.loopIn !== null ? 1 : 0) : s.loop ? 1 : 0
      if (mode === 'sampler') {
        const slot = sampler.get().pads[samplerBase(deck.name) + i]
        return slot.playing ? 0.5 : slot.name ? 1 : 0 // loaded: lit; sounding: blinking
      }
      return s.stems[STEMS[i]] ? 1 : 0
    }
    if (what === 'padModeCue') return padModes.get()[deck.name as 'A' | 'B'] === 'cue' ? 1 : 0
    if (what === 'padModeLoop') return padModes.get()[deck.name as 'A' | 'B'] === 'loop' ? 1 : 0
    if (what === 'padModeStems') {
      const m = padModes.get()[deck.name as 'A' | 'B']
      return m === 'stems' ? 1 : m === 'sampler' ? 0.5 : 0 // SAMPLER is SHIFT + STEMS: its light blinks
    }
    return 0
  }
  if (id.startsWith('moves.')) return moves.get().running === id.slice(6) ? 1 : 0
  if (id === 'mixer.fadeA') return mixer.get().fading === 0 ? 1 : 0
  if (id === 'mixer.fadeB') return mixer.get().fading === 1 ? 1 : 0
  if (id === 'mixer.rec') return mixer.get().recording ? 1 : 0
  if (id === 'rack.autodub') return autoDub.get().on ? 1 : 0
  if (id === 'rack.killLow') return isolator.get().killLow ? 1 : 0
  if (id === 'rack.killMid') return isolator.get().killMid ? 1 : 0
  if (id === 'rack.killTop') return isolator.get().killTop ? 1 : 0
  if (id === 'rack.talk' || id === 'rack.talkHold') return mic.get().talk ? 1 : 0
  if (id === 'mixer.cueMaster') return mixer.get().cueMix > 0.5 ? 1 : 0
  if (id === 'mixer.beatmatch') return decks.some((d) => d.get().syncOn) ? 1 : 0
  if (id === 'browser.open') return ui.get().tab === 'library' ? 1 : 0
  return 0
}

class Midi extends Store<MidiState> {
  private access: MIDIAccess | null = null
  /** Controllers that take light messages back (the known ones, by name). */
  private outputs: MIDIOutput[] = []
  /** Last value sent to each light, so only changes go out. */
  private lit = new Map<string, number>()
  private blink = false
  private ledQueued = false

  constructor() {
    super({
      supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
      connected: false,
      inputs: [],
      mappings: loadMappings(),
      learning: null,
      last: null,
      error: null,
    })
    // Desktop app: MIDI is on from the start, so a controller just plugged in works straight away.
    if (this.state.supported && localStorage.getItem(LS_ON) !== '0') void this.connect()
    // Lights: follow the decks, transitions and mixer; a loaded deck that is not playing blinks its PLAY.
    for (const store of [...decks, moves, mixer, ui, padModes, sampler, autoDub, isolator, mic]) store.subscribe(() => this.queueLeds())
    // Closing the app leaves the controller dark, not frozen with the last lights on.
    window.addEventListener('beforeunload', () => {
      for (const key of this.lit.keys()) {
        const m = key.match(/^n:(\d+):(\d+)$/)
        if (m) for (const out of this.outputs) out.send([0x90 | Number(m[1]), Number(m[2]), 0])
      }
    })
    window.setInterval(() => {
      this.blink = !this.blink
      this.queueLeds() // also catches CUE lighting when the deck is parked on its cue point
    }, 450)
  }

  async connect(): Promise<void> {
    if (!this.state.supported) return
    try {
      this.access = await navigator.requestMIDIAccess()
      localStorage.setItem(LS_ON, '1')
      this.access.onstatechange = () => this.bind()
      this.bind()
      this.set({ connected: true, error: null })
    } catch {
      this.set({ error: 'Acesso MIDI recusado pelo browser' })
    }
  }

  private bind(): void {
    if (!this.access) return
    const names: string[] = []
    this.access.inputs.forEach((input) => {
      if (input.state !== 'connected') return
      names.push(input.name || 'Dispositivo MIDI')
      input.onmidimessage = (e) => this.handle(e, input.name || '')
    })
    this.set({ inputs: names })
    const isKnown = (name: string | null) => presets.some((p) => !p.device && p.match?.test(name ?? '')) // lights only on the main controller
    this.outputs = []
    this.access.outputs.forEach((o) => {
      if (o.state === 'connected' && isKnown(o.name)) this.outputs.push(o)
    })
    this.lit.clear() // a controller just plugged in has every light off: send them all again
    this.queueLeds()
    // A known controller gets its own preset by itself, unless the DJ has made the mapping their own:
    // nothing mapped yet, another controller's factory preset, or an older version of this one are replaced.
    // Extra devices (keyboard…) get their own preset once, if they have nothing mapped yet.
    for (const p of presets) {
      if (!p.device || !names.includes(p.device)) continue
      const build = p.build()
      const mine = Object.entries(this.state.mappings).filter(([k]) => k.startsWith('d:' + p.device + '|'))
      // Nothing mapped yet, or an older version of this preset not changed by hand (each of its keys is still in it).
      const untouched = mine.every(([k, v]) => build[k] === v || (k.endsWith('|keys') && v === 'dubbox.keys'))
      if (untouched && mine.length !== Object.keys(build).length) this.applyPreset(p.name)
    }
    const known = presets.find((p) => p.match && !p.device && names.some((n) => p.match!.test(n)))
    if (known) {
      const main = Object.fromEntries(Object.entries(this.state.mappings).filter(([k]) => !k.startsWith('d:')))
      const now = JSON.stringify(sorted(main))
      const fresh = JSON.stringify(sorted(known.build()))
      const factory = !Object.keys(main).length || presets.some((p) => !p.device && JSON.stringify(sorted(p.build())) === now)
      const untouched = localStorage.getItem(LS_APPLIED) === now // last applied preset, not changed since
      if (now !== fresh && (factory || untouched)) this.applyPreset(known.name)
    }
  }

  /** Lights follow the app: refreshed on any change, at most once a frame. */
  queueLeds(): void {
    if (this.ledQueued || !this.outputs.length) return
    this.ledQueued = true
    requestAnimationFrame(() => {
      this.ledQueued = false
      this.sendLeds()
    })
  }

  private sendLeds(): void {
    for (const [key, id] of Object.entries(this.state.mappings)) {
      const m = key.match(/^n:(\d+):(\d+)$/)
      if (!m) continue
      const want = ledFor(id)
      const value = want === 0.5 ? (this.blink ? 1 : 0) : want
      if (this.lit.get(key) === value) continue
      this.lit.set(key, value)
      const message = [0x90 | Number(m[1]), Number(m[2]), value ? 0x7f : 0x00]
      for (const out of this.outputs) {
        try {
          out.send(message)
        } catch {
          /* unplugged meanwhile */
        }
      }
    }
  }

  learn(actionId: string | null): void {
    this.set({ learning: this.state.learning === actionId ? null : actionId })
  }

  unmap(actionId: string): void {
    const mappings = Object.fromEntries(Object.entries(this.state.mappings).filter(([, id]) => id !== actionId))
    this.saveMappings(mappings)
  }

  /** Replaces every mapping with a factory preset. */
  applyPreset(name: string): void {
    const preset = presets.find((p) => p.name === name)
    if (!preset) return
    const map = preset.build()
    const prefix = preset.device ? 'd:' + preset.device + '|' : null
    // Only this preset's own part is replaced: the other controller keeps its mappings.
    const keep = Object.entries(this.state.mappings).filter(([k]) => (prefix ? !k.startsWith(prefix) : k.startsWith('d:')))
    this.saveMappings({ ...Object.fromEntries(keep), ...map })
    // Remembered, so a later version of the preset can replace it as long as nothing was changed by hand.
    if (!prefix) localStorage.setItem(LS_APPLIED, JSON.stringify(sorted(map)))
  }

  keyFor(actionId: string): string | undefined {
    return Object.keys(this.state.mappings).find((k) => this.state.mappings[k] === actionId)
  }

  private saveMappings(mappings: Record<string, string>): void {
    // A light whose button loses its function goes off.
    for (const key of this.lit.keys()) {
      const m = key.match(/^n:(\d+):(\d+)$/)
      if (m && !mappings[key]) for (const out of this.outputs) out.send([0x90 | Number(m[1]), Number(m[2]), 0])
    }
    this.lit.clear()
    localStorage.setItem(LS_MAP, JSON.stringify(mappings))
    this.set({ mappings })
    this.queueLeds()
  }

  private handle(e: MIDIMessageEvent, device = ''): void {
    const data = e.data
    if (!data || data.length < 2) return
    const status = data[0]
    if (status >= 0xf0) return // clock / sysex
    const type = status & 0xf0
    const channel = status & 0x0f
    const d1 = data[1]
    const d2 = data.length > 2 ? data[2] : 0
    const noteOff = type === 0x80
    if (!noteOff && type !== 0x90 && type !== 0xb0 && type !== 0xe0 && type !== 0xc0) return // aftertouch… ignored

    // Program change (the numbered program buttons of a keyboard) acts as a button press.
    const plain =
      type === 0x90 || noteOff
        ? `n:${channel}:${d1}`
        : type === 0xb0
          ? `c:${channel}:${d1}`
          : type === 0xc0
            ? `g:${channel}:${d1}`
            : `p:${channel}`
    const released = noteOff || (type === 0x90 && d2 === 0)

    // Several controllers: a mapping can belong to one of them ("d:<name>|…"). Such a device can also be
    // kept to its own mappings only, so its channel 1 never collides with another controller's.
    const dev = 'd:' + device + '|'
    const own = (k: string) => this.state.mappings[dev + k]
    if (!this.state.learning) {
      // Keyboard mode: every key plays the Dub Box (siren notes), the wheels bend and wobble it.
      if (own('keys') && (type === 0x90 || noteOff)) {
        if (released) sirenKeys.noteOff(d1)
        else sirenKeys.noteOn(d1)
        this.set({ last: device + ' · tecla ' + d1 })
        return
      }
      if (own('keys') && type === 0xe0) return sirenKeys.pitchWheel((((d2 << 7) | d1) - 8192) / 8192)
      if (own('keys') && type === 0xb0 && d1 === 1 && !own(plain)) return sirenKeys.modWheel(d2 / 127)
    }
    if (own(plain) === 'ignore') return // e.g. the bank-select that comes with a program change
    const isolated = !!own('only')
    const lookup = (k: string) => own(k) ?? (isolated ? undefined : this.state.mappings[k])

    // SHIFT of a deck: only remembered (it changes what the other buttons do), and lit while held.
    const shiftOf = lookup(plain)?.match(/^deck([AB])\.shift$/)
    if (shiftOf) {
      shiftHeld[shiftOf[1] as 'A' | 'B'] = !released
      this.queueLeds()
      if (!this.state.learning) return
    }
    // With SHIFT held, a button's second function (mapped as "s:…") wins over its normal one.
    const shifted = !shiftOf && (shiftHeld.A || shiftHeld.B)
    const base = shifted && (lookup('s:' + plain) || this.state.learning) ? 's:' + plain : plain
    // Learning with more than one controller plugged in: the mapping belongs to the one that was moved.
    const key = this.state.learning ? (this.state.inputs.length > 1 ? dev + base : base) : own(base) ? dev + base : base
    if (noteOff) {
      // Only "hold" actions care about the release of a key.
      const held = actionById.get(lookup(base) ?? '')
      if (held?.type === 'hold') held.run(0)
      return
    }

    const learning = this.state.learning
    if (learning) {
      if (released) return
      const mappings = Object.fromEntries(Object.entries(this.state.mappings).filter(([, id]) => id !== learning))
      mappings[key] = learning
      this.saveMappings(mappings)
      this.set({ learning: null, last: describeKey(key) })
      return
    }

    // Fine byte of a 14-bit fader (CC n+32) whose coarse byte is mapped: nothing to do, nothing to report.
    if (type === 0xb0 && d1 >= 32 && d1 < 64 && lookup(`c:${channel}:${d1 - 32}`)) return
    const action = actionById.get(lookup(base) ?? '')
    if (!action) {
      if (!released) this.set({ last: describeKey(key) + ' (sem mapeamento)' })
      return
    }
    if (type === 0xc0) {
      if (action.type === 'button' || action.type === 'hold') action.run(1)
      return
    }
    const unit = type === 0xe0 ? ((d2 << 7) | d1) / 16383 : d2 / 127
    switch (action.type) {
      case 'button':
        if (d2 > 0) action.run(1)
        break
      case 'hold':
        action.run(d2 > 0 ? 1 : 0)
        break
      case 'fader':
        action.run(unit)
        break
      case 'center':
        // 7-bit controls have no exact middle: treat 63/64 as the detent.
        action.run(type === 0xb0 && (d2 === 63 || d2 === 64) ? 0 : unit * 2 - 1)
        break
      case 'jog':
        // Relative encoders: 1..63 = forward, 65..127 = backward (two's complement).
        if (type === 0xb0 && d2 !== 0 && d2 !== 64) action.run(d2 < 64 ? d2 : d2 - 128)
        break
    }
  }
}

export const midi = new Midi()
