import { mixer } from './engine/mixer'
import { mic, VOICE_PRESETS, VOICE_TIMES, type VoiceTime } from './engine/mic'
import { COMP_PRESETS, DYNAMICS_DEFAULT, LIMITS } from './engine/dynamics'
import { dubBox, FACTORY, PATCH_LIMITS, ECHO_BEATS, type Patch } from './engine/dubbox'
import { dubSettings, DUB_BEATS, DUB_LIMITS, DUB_PRESETS } from './engine/dub'
import { DIVISIONS, outboard } from './engine/outboard'
import { isolator } from './engine/isolator'
import { autoDub } from './engine/autodub'

/**
 * The phone controller's sound-shaping pages (Dub Box, deck DUB, tape echo, isolator, compressor…), described as
 * data: the page builds its knobs, switches and choices from this list, sent once when it connects. Each control
 * is addressed by its key `k`; the phone sends 0..1 for knobs (-1..1 when centred), the option for choices, and
 * true / false for switches. Buttons are the same action ids as a MIDI controller.
 */

type Num = { kind: 'knob'; k: string; label: string; center?: boolean; get(): number; set(v: number): void; show(): string }
type Pick = { kind: 'choice'; k: string; label: string; wrap?: boolean; options: { v: string; label: string }[]; get(): string; set(v: string): void }
type Flip = { kind: 'switch'; k: string; label: string; get(): boolean; set(on: boolean): void }
/** A one-shot of the panel (back to the default…): the phone sends true. */
type Do = { kind: 'do'; k: string; label: string; run(): void }
type Btn = { kind: 'button'; id: string; label: string; hold?: boolean; lit?: string } // lit: key of a switch / value lighting it
export type Control = Num | Pick | Flip | Btn | Do
export interface Section {
  title: string
  hint?: string
  open?: boolean // shown open the first time (the phone remembers what the DJ opens and closes)
  controls: Control[]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lin = (lo: number, hi: number) => ({ to: (u: number) => lo + clamp(u, 0, 1) * (hi - lo), from: (x: number) => clamp((x - lo) / (hi - lo), 0, 1) })
const log = (lo: number, hi: number) => ({
  to: (u: number) => lo * Math.pow(hi / lo, clamp(u, 0, 1)),
  from: (x: number) => clamp(Math.log(x / lo) / Math.log(hi / lo), 0, 1),
})
const hz = (x: number) => (x >= 1000 ? (x / 1000).toFixed(x >= 10000 ? 0 : 1) + ' kHz' : Math.round(x) + ' Hz')
const pct = (x: number) => Math.round(x * 100) + '%'
const db = (x: number) => (x > 0 ? '+' : '') + x.toFixed(1) + ' dB'
const ms = (s: number) => (s >= 1 ? s.toFixed(2) + ' s' : Math.round(s * 1000) + ' ms')

function knob(k: string, label: string, scale: ReturnType<typeof lin>, get: () => number, set: (x: number) => void, show: (x: number) => string): Num {
  return { kind: 'knob', k, label, get: () => scale.from(get()), set: (u) => set(scale.to(u)), show: () => show(get()) }
}

// ───────── Dub Box: the sound FIRE plays ─────────
const patch = () => dubBox.get().patch
function patchKnob(field: keyof typeof PATCH_LIMITS, label: string, logScale: boolean, show: (x: number) => string): Num {
  const [lo, hi] = PATCH_LIMITS[field]
  return knob('box.' + field, label, logScale ? log(lo, hi) : lin(lo, hi), () => patch()[field] as number, (x) => dubBox.updatePatch({ [field]: x } as Partial<Patch>), show)
}
const st = (x: number) => (x > 0 ? '+' : '') + x.toFixed(1) + ' st'

const dubBoxSections: Section[] = [
  {
    title: 'FIRE presets',
    hint: 'tap to pick',
    open: true,
    controls: [
      {
        kind: 'choice',
        k: 'box.preset',
        label: '',
        wrap: true,
        options: [], // filled when the phone connects (the DJ's own sounds too)
        get: () => dubBox.get().preset ?? '',
        set: (v) => dubBox.usePreset(v),
      },
      { kind: 'do', k: 'box.reset', label: 'UNDO TWEAKS', run: () => dubBox.resetToPreset() },
      { kind: 'do', k: 'box.surprise', label: 'SURPRISE', run: () => dubBox.surprise() },
    ],
  },
  {
    title: 'FIRE sound',
    hint: 'the Dub Box\'s voice',
    controls: [
      {
        kind: 'choice',
        k: 'box.voice',
        label: 'VOICE',
        options: [
          { v: 'siren', label: 'SIRENE' },
          { v: 'noise', label: 'NOISE' },
          { v: 'spring', label: 'SPRING' },
          { v: 'sample', label: 'SAMPLE' },
        ],
        get: () => patch().voice,
        set: (v) => dubBox.updatePatch({ voice: v as Patch['voice'] }),
      },
      {
        kind: 'choice',
        k: 'box.wave',
        label: 'WAVE',
        options: [
          { v: 'sine', label: 'SINE' },
          { v: 'triangle', label: 'TRI' },
          { v: 'square', label: 'QUAD' },
          { v: 'sawtooth', label: 'SERRA' },
        ],
        get: () => patch().wave,
        set: (v) => dubBox.updatePatch({ wave: v as OscillatorType }),
      },
      patchKnob('pitch', 'PITCH', true, hz),
      patchKnob('tone', 'TONE', true, hz),
      patchKnob('resonance', 'RESON.', false, (x) => x.toFixed(0) + ' dB'),
      patchKnob('sweep', 'SWEEP', false, st),
      patchKnob('sweepTime', 'T. SWEEP', true, ms),
      patchKnob('attack', 'ATTACK', true, ms),
      patchKnob('release', 'RELEASE', true, ms),
    ],
  },
  {
    title: 'LFO',
    controls: [
      {
        kind: 'choice',
        k: 'box.lfoShape',
        label: 'SHAPE',
        options: [
          { v: 'sine', label: 'SINE' },
          { v: 'triangle', label: 'TRI' },
          { v: 'square', label: 'QUAD' },
          { v: 'sawtooth', label: 'SERRA' },
          { v: 'random', label: 'RAND.' },
        ],
        get: () => patch().lfoShape,
        set: (v) => dubBox.updatePatch({ lfoShape: v as Patch['lfoShape'] }),
      },
      patchKnob('lfoRate', 'RATE', true, (x) => x.toFixed(x < 1 ? 2 : 1) + ' Hz'),
      patchKnob('lfoDepth', 'DEPTH', false, (x) => x.toFixed(1) + ' st'),
    ],
  },
  {
    title: 'Dub Box effects',
    controls: [
      { kind: 'knob', k: 'box.filter', label: 'FILTER', center: true, get: () => dubBox.get().filter, set: (v) => dubBox.setFilter(v), show: () => filterText(dubBox.get().filter) },
      patchKnob('echo', 'ECHO', false, pct),
      patchKnob('feedback', 'FDBK', false, pct),
      patchKnob('echoTone', 'ECHO TONE', true, hz),
      patchKnob('spring', 'SPRING', false, pct),
      {
        kind: 'choice',
        k: 'box.echoBeats',
        label: 'ECHO TIME',
        options: ECHO_BEATS.map((b) => ({ v: String(b), label: beatsText(b) })),
        get: () => String(patch().echoBeats),
        set: (v) => dubBox.updatePatch({ echoBeats: Number(v) }),
      },
      { kind: 'switch', k: 'box.latch', label: 'LATCH FIRE', get: () => dubBox.get().mode === 'latch', set: (on) => dubBox.setMode(on ? 'latch' : 'hold') },
      { kind: 'switch', k: 'box.rehearse', label: 'REHEARSE (PHONES ONLY)', get: () => dubBox.get().rehearse, set: (on) => dubBox.setRehearse(on) },
      { kind: 'switch', k: 'box.loop', label: 'SAMPLE LOOP', get: () => patch().loop, set: (on) => dubBox.updatePatch({ loop: on }) },
      { kind: 'switch', k: 'box.reverse', label: 'SAMPLE REVERSE', get: () => patch().reverse, set: (on) => dubBox.updatePatch({ reverse: on }) },
      { kind: 'do', k: 'box.reset2', label: 'UNDO TWEAKS', run: () => dubBox.resetToPreset() },
    ],
  },
]

function beatsText(b: number): string {
  return b === 0.25 ? '1/4' : b === 0.5 ? '1/2' : b === 0.75 ? '3/4' : b === 1.5 ? '1½' : String(b)
}
function filterText(v: number): string {
  return Math.abs(v) < 0.02 ? 'open' : v < 0 ? 'low ' + Math.round(-v * 100) + '%' : 'high ' + Math.round(v * 100) + '%'
}

// ───────── DUB button of the decks ─────────
const dub = () => dubSettings.get()
function dubKnob(field: keyof typeof DUB_LIMITS, label: string, logScale: boolean, show: (x: number) => string): Num {
  const [lo, hi] = DUB_LIMITS[field]
  return knob('dub.' + field, label, logScale ? log(lo, hi) : lin(lo, hi), () => dub()[field], (x) => dubSettings.update({ [field]: x }), show)
}
const deckDub: Section = {
  title: 'Deck DUB button',
  hint: 'the echo DUB throws the music into',
  open: true,
  controls: [
    {
      kind: 'choice',
      k: 'dub.preset',
      label: 'PRESETS',
      wrap: true,
      options: DUB_PRESETS.map((p) => ({ v: p.name, label: p.name.toUpperCase() })),
      get: () => DUB_PRESETS.find((p) => (Object.keys(p.settings) as (keyof typeof p.settings)[]).every((f) => p.settings[f] === dub()[f]))?.name ?? '',
      set: (v) => {
        const p = DUB_PRESETS.find((x) => x.name === v)
        if (p) dubSettings.update({ ...p.settings })
      },
    },
    {
      kind: 'choice',
      k: 'dub.beats',
      label: 'TIME',
      options: DUB_BEATS.map((b) => ({ v: String(b.value), label: beatsText(b.value) })),
      get: () => String(dub().beats),
      set: (v) => dubSettings.update({ beats: Number(v) }),
    },
    dubKnob('feedback', 'FDBK', false, pct),
    dubKnob('tone', 'TONE', true, hz),
    dubKnob('lowCut', 'LOW CUT', true, hz),
    dubKnob('space', 'SPRING', false, pct),
    dubKnob('drift', 'TAPE', false, pct),
    dubKnob('level', 'LEVEL', false, pct),
    { kind: 'switch', k: 'dub.cut', label: 'CUTS THE MUSIC', get: () => dub().dry === 'cut', set: (on) => dubSettings.update({ dry: on ? 'cut' : 'keep' }) },
    { kind: 'switch', k: 'dub.fade', label: 'RELEASE, DIES', get: () => dub().release === 'fade', set: (on) => dubSettings.update({ release: on ? 'fade' : 'ring' }) },
    { kind: 'switch', k: 'dub.latch', label: 'LATCH DUB', get: () => dub().mode === 'latch', set: (on) => dubSettings.update({ mode: on ? 'latch' : 'hold' }) },
    { kind: 'do', k: 'dub.reset', label: 'BACK TO DEFAULT', run: () => dubSettings.update({ ...DUB_PRESETS[0].settings }) },
  ],
}

// ───────── tape echo, weight, isolator ─────────
const ob = () => outboard.get()
const iso = () => isolator.get()
const fxSections: Section[] = [
  {
    title: 'Tape echo',
    open: true,
    controls: [
      { kind: 'button', id: 'rack.throwA', label: 'THROW A', hold: true, lit: 'echo.throwA' },
      { kind: 'button', id: 'rack.throwB', label: 'THROW B', hold: true, lit: 'echo.throwB' },
      { kind: 'button', id: 'rack.tap', label: 'TAP' },
      { kind: 'button', id: 'rack.echoTail', label: 'CUT TAIL' },
      {
        kind: 'choice',
        k: 'echo.division',
        label: 'DIVISION',
        options: DIVISIONS.map((d) => ({ v: d.id, label: d.id })),
        get: () => (ob().timeMode === 'sync' ? ob().division : ''),
        set: (v) => outboard.update({ division: v as (typeof DIVISIONS)[number]['id'], timeMode: 'sync' }),
      },
      knob('echo.feedback', 'FDBK', lin(0, 1.1), () => ob().feedback, (x) => outboard.update({ feedback: x }), pct),
      knob('echo.tone', 'TONE', lin(0, 1), () => ob().tone, (x) => outboard.update({ tone: x }), pct),
      knob('echo.wobble', 'TAPE', lin(0, 1), () => ob().wobble, (x) => outboard.update({ wobble: x }), pct),
      knob('echo.spring', 'SPRING', lin(0, 1), () => ob().spring, (x) => outboard.update({ spring: x }), pct),
      knob('echo.level', 'LEVEL', lin(0, 1), () => ob().echoLevel, (x) => outboard.update({ echoLevel: x }), pct),
      knob('echo.sendA', 'SEND A', lin(0, 1), () => ob().send.A, (x) => outboard.setSend('A', x), pct),
      knob('echo.sendB', 'SEND B', lin(0, 1), () => ob().send.B, (x) => outboard.setSend('B', x), pct),
      { kind: 'button', id: 'rack.crash', label: 'KICK THE SPRING' },
      {
        kind: 'do',
        k: 'echo.reset',
        label: 'BACK TO DEFAULT',
        run: () => outboard.update({ division: '3/8', timeMode: 'sync', feedback: 0.55, tone: 0.45, wobble: 0.35, spring: 0.4, echoLevel: 0.8 }),
      },
    ],
  },
  {
    title: 'Sound system',
    controls: [
      knob('ss.weight', 'WEIGHT', lin(0, 1), () => ob().weight, (x) => outboard.update({ weight: x }), (x) => '+' + (x * 9).toFixed(1) + ' dB'),
      knob('ss.weightHz', 'FREQ. PESO', lin(40, 120), () => ob().weightHz, (x) => outboard.update({ weightHz: x }), hz),
      { kind: 'button', id: 'rack.drop', label: 'DROP', lit: 'ss.dropping' },
      // Auto dub is parked for now (roadmap): no button on the phone either.
      { kind: 'do', k: 'ss.reset', label: 'BACK TO DEFAULT', run: () => outboard.update({ weight: 0.3, weightHz: 60 }) },
    ],
  },
  {
    title: 'Master isolator',
    hint: 'take out or push each band',
    controls: [
      knob('iso.low', 'LOW', lin(0, 1.5), () => iso().low, (x) => isolator.update({ low: x }), pct),
      knob('iso.mid', 'MID', lin(0, 1.5), () => iso().mid, (x) => isolator.update({ mid: x }), pct),
      knob('iso.top', 'HIGH', lin(0, 1.5), () => iso().top, (x) => isolator.update({ top: x }), pct),
      { kind: 'switch', k: 'iso.killLow', label: 'KILL LOW', get: () => iso().killLow, set: (on) => isolator.kill('low', on) },
      { kind: 'switch', k: 'iso.killMid', label: 'KILL MID', get: () => iso().killMid, set: (on) => isolator.kill('mid', on) },
      { kind: 'switch', k: 'iso.killTop', label: 'KILL HIGH', get: () => iso().killTop, set: (on) => isolator.kill('top', on) },
      { kind: 'switch', k: 'iso.filterOn', label: 'MASTER FILTERS', get: () => iso().filterOn, set: (on) => isolator.update({ filterOn: on }) },
      knob('iso.hp', 'LOW CUT', lin(0, 1), () => iso().hp, (x) => isolator.update({ hp: x, filterOn: true }), (x) => hz(20 * Math.pow(100, x))),
      { kind: 'do', k: 'iso.reset', label: 'ALL FLAT (DEFAULT)', run: () => isolator.reset() },
      knob('iso.lp', 'HIGH CUT', lin(0, 1), () => iso().lp, (x) => isolator.update({ lp: x, filterOn: true }), (x) => hz(20000 * Math.pow(250 / 20000, x))),
    ],
  },
]

// ───────── master: compressor, limiter, headphones ─────────
const dyn = () => mixer.get().dynamics
function dynKnob(field: keyof typeof LIMITS, label: string, logScale: boolean, show: (x: number) => string): Num {
  const [lo, hi] = LIMITS[field]
  return knob('dyn.' + field, label, logScale ? log(lo, hi) : lin(lo, hi), () => dyn()[field], (x) => mixer.setDynamics({ [field]: x, ...(field === 'ceiling' || field === 'limRelease' ? {} : { preset: null }), ...(field === 'makeup' ? { autoGain: false } : {}) }), show)
}
const masterSections: Section[] = [
  {
    title: 'Master compressor',
    open: true,
    controls: [
      { kind: 'switch', k: 'dyn.comp', label: 'COMPRESSOR', get: () => dyn().comp, set: (on) => mixer.setDynamics({ comp: on }) },
      {
        kind: 'choice',
        k: 'dyn.preset',
        label: 'PRESET',
        options: COMP_PRESETS.map((p) => ({ v: p.name, label: p.name.toUpperCase() })),
        get: () => dyn().preset ?? '',
        set: (v) => {
          const p = COMP_PRESETS.find((x) => x.name === v)
          if (p) mixer.setDynamics({ ...p.set, preset: p.name, comp: true })
        },
      },
      dynKnob('threshold', 'THRESH', false, db),
      dynKnob('ratio', 'RATIO', true, (x) => x.toFixed(1) + ':1'),
      dynKnob('attack', 'ATTACK', true, ms),
      dynKnob('release', 'RELEASE', true, ms),
      dynKnob('makeup', 'GAIN', false, db),
      { kind: 'switch', k: 'dyn.auto', label: 'AUTO GAIN', get: () => dyn().autoGain, set: (on) => mixer.setDynamics({ autoGain: on }) },
      {
        kind: 'do',
        k: 'dyn.reset',
        label: 'BACK TO DEFAULT',
        run: () => {
          const { threshold, ratio, attack, release, makeup, preset, autoGain } = DYNAMICS_DEFAULT
          mixer.setDynamics({ threshold, ratio, attack, release, makeup, preset, autoGain })
        },
      },
    ],
  },
  {
    title: 'Limiter',
    hint: 'the ceiling of the sound',
    controls: [
      { kind: 'switch', k: 'dyn.lim', label: 'LIMITER', get: () => dyn().lim, set: (on) => mixer.setDynamics({ lim: on }) },
      dynKnob('ceiling', 'CEILING', false, db),
      dynKnob('limRelease', 'RELEASE', true, ms),
      { kind: 'do', k: 'lim.reset', label: 'BACK TO DEFAULT', run: () => mixer.setDynamics({ ceiling: DYNAMICS_DEFAULT.ceiling, limRelease: DYNAMICS_DEFAULT.limRelease }) },
    ],
  },
  {
    title: 'Headphone e crossfader',
    controls: [
      knob('hp.volume', 'PHONES VOLUME', lin(0, 1), () => mixer.get().hpVolume, (x) => mixer.setHeadphoneVolume(x), pct),
      knob('hp.mix', 'CUE / MASTER', lin(0, 1), () => mixer.get().cueMix, (x) => mixer.setCueMix(x), (x) => (x < 0.05 ? 'cue only' : x > 0.95 ? 'master only' : pct(x))),
      {
        kind: 'choice',
        k: 'xf.curve',
        label: 'CROSSFADER CURVE',
        options: [
          { v: 'smooth', label: 'SMOOTH' },
          { v: 'cut', label: 'CUT' },
          { v: 'thru', label: 'OFF' },
        ],
        get: () => mixer.get().xfCurve,
        set: (v) => mixer.setCrossfaderCurve(v as 'smooth' | 'cut' | 'thru'),
      },
    ],
  },
]

// ───────── Mic: the MC's voice, from the Mac's input or from the phone itself ─────────
const mc = () => mic.get()
const micSections: Section[] = [
  {
    title: 'Voice',
    hint: 'talk, level, ducking',
    open: true,
    controls: [
      { kind: 'button', id: 'rack.talkHold', label: 'HOLD TO TALK', hold: true, lit: 'mic.talk' },
      { kind: 'switch', k: 'mic.talk', label: 'TALK (LATCH)', get: () => mc().talk, set: (on) => mic.setTalk(on) },
      { kind: 'button', id: 'rack.voiceThrow', label: 'MIC THROW', hold: true, lit: 'mic.throwing' },
      knob('mic.level', 'LEVEL', lin(0, 1.5), () => mc().level, (x) => mic.update({ level: x }), pct),
      knob('mic.duck', 'DUCK', lin(0, 1), () => mc().duck, (x) => mic.update({ duck: x }), (x) => (x < 0.02 ? 'never' : '−' + Math.round(x * 12) + ' dB')),
    ],
  },
  {
    title: 'Colour',
    hint: 'presets, filter, drive',
    open: true,
    controls: [
      {
        kind: 'choice',
        k: 'mic.preset',
        label: 'PRESET',
        options: VOICE_PRESETS.map((p) => ({ v: p.id, label: p.label })),
        get: () => VOICE_PRESETS.find((p) => Object.entries(p.set).every(([k, v]) => mc()[k as keyof typeof p.set] === v))?.id ?? '',
        set: (v) => {
          const p = VOICE_PRESETS.find((x) => x.id === v)
          if (p) mic.update(p.set)
        },
      },
      { kind: 'knob', k: 'mic.filter', label: 'FILTER', center: true, get: () => mc().filter, set: (v) => mic.update({ filter: v }), show: () => (Math.abs(mc().filter) < 0.02 ? 'open' : mc().filter < 0 ? 'dark ' + Math.round(-mc().filter * 100) + '%' : 'radio ' + Math.round(mc().filter * 100) + '%') },
      knob('mic.drive', 'DRIVE', lin(0, 1), () => mc().drive, (x) => mic.update({ drive: x }), (x) => (x < 0.02 ? 'clean' : pct(x))),
    ],
  },
  {
    title: 'Mic echo',
    hint: 'its own echo and spring',
    controls: [
      {
        kind: 'choice',
        k: 'mic.time',
        label: 'TIME',
        options: VOICE_TIMES.map((t) => ({ v: t, label: t === 'rack' ? 'TAPE' : t })),
        get: () => mc().time,
        set: (v) => mic.update({ time: v as VoiceTime }),
      },
      knob('mic.echo', 'SEND', lin(0, 1), () => mc().echo, (x) => mic.update({ echo: x }), pct),
      knob('mic.repeats', 'FEEDBACK', lin(0, 0.95), () => mc().repeats, (x) => mic.update({ repeats: x }), pct),
      knob('mic.tone', 'TONE', lin(0, 1), () => mc().tone, (x) => mic.update({ tone: x }), (x) => (x < 0.35 ? 'dark' : x > 0.7 ? 'bright' : 'tape')),
      knob('mic.spring', 'SPRING', lin(0, 1), () => mc().spring, (x) => mic.update({ spring: x }), pct),
      knob('mic.fx', 'EFFECTS', lin(0, 1.5), () => mc().fx, (x) => mic.update({ fx: x }), pct),
    ],
  },
]

/** Pages of the phone: their sections, in order. */
export const PANELS: Record<'dub' | 'fx' | 'mix' | 'mic', Section[]> = {
  dub: [...dubBoxSections, deckDub],
  fx: fxSections,
  mix: masterSections,
  mic: micSections,
}

const all = Object.values(PANELS).flatMap((secs) => secs.flatMap((s) => s.controls))
const byKey = new Map(all.filter((c): c is Num | Pick | Flip | Do => c.kind !== 'button').map((c) => [c.k, c]))

/** Layout for the phone (no functions): sent once when it connects. */
export function panelLayout() {
  const strip = (c: Control) => {
    if (c.kind === 'button') return c
    if (c.kind === 'choice') {
      // The Dub Box's sounds: the app's own and the DJ's, as they are when the phone connects.
      const options = c.k === 'box.preset' ? [...FACTORY, ...dubBox.get().user].map((p) => ({ v: p.name, label: p.name })) : c.options
      return { kind: c.kind, k: c.k, label: c.label, wrap: !!c.wrap, options }
    }
    if (c.kind === 'do') return { kind: c.kind, k: c.k, label: c.label }
    if (c.kind === 'knob') return { kind: c.kind, k: c.k, label: c.label, center: !!c.center }
    return { kind: c.kind, k: c.k, label: c.label }
  }
  return Object.fromEntries(Object.entries(PANELS).map(([page, secs]) => [page, secs.map((s) => ({ ...s, controls: s.controls.map(strip) }))]))
}

/** Every value now: knobs as 0..1 (or -1..1) with their readout, choices, switches, and a few lights. */
export function panelValues(): { v: Record<string, number | string | boolean>; r: Record<string, string> } {
  const v: Record<string, number | string | boolean> = {}
  const r: Record<string, string> = {}
  for (const [k, c] of byKey) {
    if (c.kind === 'do') continue
    if (c.kind === 'knob') {
      v[k] = Math.round(c.get() * 1000) / 1000
      r[k] = c.show()
    } else v[k] = c.get()
  }
  v['echo.throwA'] = ob().throwing.A
  v['echo.throwB'] = ob().throwing.B
  v['ss.dropping'] = ob().dropping
  v['ss.autodub'] = autoDub.get().on
  v['mic.on'] = mc().on
  v['mic.throwing'] = mc().throwing
  v['mic.phone'] = mc().phone
  v['mic.source'] = mc().source
  v['mic.speaking'] = mc().speaking
  v['mic.error'] = mc().error ?? ''
  return { v, r }
}

/** A control moved on the phone. Unknown keys and wrong value types do nothing. */
export function setPanel(k: string, value: unknown): boolean {
  const c = byKey.get(k)
  if (!c) return false
  if (c.kind === 'knob' && typeof value === 'number' && Number.isFinite(value)) c.set(clamp(value, c.center ? -1 : 0, 1))
  else if (c.kind === 'do' && value === true) c.run()
  else if (c.kind === 'choice' && typeof value === 'string' && (c.k === 'box.preset' || c.options.some((o) => o.v === value))) c.set(value)
  else if (c.kind === 'switch' && typeof value === 'boolean') c.set(value)
  else return false
  return true
}
