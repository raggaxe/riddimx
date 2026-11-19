import { mixer } from './engine/mixer'
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
    title: 'Sons prontos do FIRE',
    hint: 'toque para escolher',
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
      { kind: 'do', k: 'box.reset', label: 'DESFAZER MEXIDAS', run: () => dubBox.resetToPreset() },
      { kind: 'do', k: 'box.surprise', label: 'SURPRESA', run: () => dubBox.surprise() },
    ],
  },
  {
    title: 'Som do FIRE',
    hint: 'o timbre do Dub Box',
    controls: [
      {
        kind: 'choice',
        k: 'box.voice',
        label: 'VOZ',
        options: [
          { v: 'siren', label: 'SIRENE' },
          { v: 'noise', label: 'RUÍDO' },
          { v: 'spring', label: 'MOLA' },
          { v: 'sample', label: 'SAMPLE' },
        ],
        get: () => patch().voice,
        set: (v) => dubBox.updatePatch({ voice: v as Patch['voice'] }),
      },
      {
        kind: 'choice',
        k: 'box.wave',
        label: 'ONDA',
        options: [
          { v: 'sine', label: 'SENO' },
          { v: 'triangle', label: 'TRI' },
          { v: 'square', label: 'QUAD' },
          { v: 'sawtooth', label: 'SERRA' },
        ],
        get: () => patch().wave,
        set: (v) => dubBox.updatePatch({ wave: v as OscillatorType }),
      },
      patchKnob('pitch', 'TOM', true, hz),
      patchKnob('tone', 'BRILHO', true, hz),
      patchKnob('resonance', 'RESSON.', false, (x) => x.toFixed(0) + ' dB'),
      patchKnob('sweep', 'SWEEP', false, st),
      patchKnob('sweepTime', 'T. SWEEP', true, ms),
      patchKnob('attack', 'ATAQUE', true, ms),
      patchKnob('release', 'SOLTURA', true, ms),
    ],
  },
  {
    title: 'Oscilação',
    controls: [
      {
        kind: 'choice',
        k: 'box.lfoShape',
        label: 'FORMA',
        options: [
          { v: 'sine', label: 'SENO' },
          { v: 'triangle', label: 'TRI' },
          { v: 'square', label: 'QUAD' },
          { v: 'sawtooth', label: 'SERRA' },
          { v: 'random', label: 'ALEAT.' },
        ],
        get: () => patch().lfoShape,
        set: (v) => dubBox.updatePatch({ lfoShape: v as Patch['lfoShape'] }),
      },
      patchKnob('lfoRate', 'VELOC.', true, (x) => x.toFixed(x < 1 ? 2 : 1) + ' Hz'),
      patchKnob('lfoDepth', 'PROFUND.', false, (x) => x.toFixed(1) + ' st'),
    ],
  },
  {
    title: 'Efeitos do Dub Box',
    controls: [
      { kind: 'knob', k: 'box.filter', label: 'FILTRO', center: true, get: () => dubBox.get().filter, set: (v) => dubBox.setFilter(v), show: () => filterText(dubBox.get().filter) },
      patchKnob('echo', 'ECO', false, pct),
      patchKnob('feedback', 'REPETE', false, pct),
      patchKnob('echoTone', 'TOM ECO', true, hz),
      patchKnob('spring', 'MOLA', false, pct),
      {
        kind: 'choice',
        k: 'box.echoBeats',
        label: 'TEMPO DO ECO',
        options: ECHO_BEATS.map((b) => ({ v: String(b), label: beatsText(b) })),
        get: () => String(patch().echoBeats),
        set: (v) => dubBox.updatePatch({ echoBeats: Number(v) }),
      },
      { kind: 'switch', k: 'box.latch', label: 'TRAVAR FIRE', get: () => dubBox.get().mode === 'latch', set: (on) => dubBox.setMode(on ? 'latch' : 'hold') },
      { kind: 'switch', k: 'box.rehearse', label: 'ENSAIAR (SÓ FONE)', get: () => dubBox.get().rehearse, set: (on) => dubBox.setRehearse(on) },
      { kind: 'switch', k: 'box.loop', label: 'SAMPLE EM LOOP', get: () => patch().loop, set: (on) => dubBox.updatePatch({ loop: on }) },
      { kind: 'switch', k: 'box.reverse', label: 'SAMPLE AO CONTRÁRIO', get: () => patch().reverse, set: (on) => dubBox.updatePatch({ reverse: on }) },
      { kind: 'do', k: 'box.reset2', label: 'DESFAZER MEXIDAS', run: () => dubBox.resetToPreset() },
    ],
  },
]

function beatsText(b: number): string {
  return b === 0.25 ? '1/4' : b === 0.5 ? '1/2' : b === 0.75 ? '3/4' : b === 1.5 ? '1½' : String(b)
}
function filterText(v: number): string {
  return Math.abs(v) < 0.02 ? 'aberto' : v < 0 ? 'grave ' + Math.round(-v * 100) + '%' : 'agudo ' + Math.round(v * 100) + '%'
}

// ───────── DUB button of the decks ─────────
const dub = () => dubSettings.get()
function dubKnob(field: keyof typeof DUB_LIMITS, label: string, logScale: boolean, show: (x: number) => string): Num {
  const [lo, hi] = DUB_LIMITS[field]
  return knob('dub.' + field, label, logScale ? log(lo, hi) : lin(lo, hi), () => dub()[field], (x) => dubSettings.update({ [field]: x }), show)
}
const deckDub: Section = {
  title: 'Botão DUB dos decks',
  hint: 'o eco que o DUB joga na música',
  open: true,
  controls: [
    {
      kind: 'choice',
      k: 'dub.preset',
      label: 'SONS PRONTOS',
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
      label: 'TEMPO',
      options: DUB_BEATS.map((b) => ({ v: String(b.value), label: beatsText(b.value) })),
      get: () => String(dub().beats),
      set: (v) => dubSettings.update({ beats: Number(v) }),
    },
    dubKnob('feedback', 'REPETE', false, pct),
    dubKnob('tone', 'BRILHO', true, hz),
    dubKnob('lowCut', 'CORTE GRAVE', true, hz),
    dubKnob('space', 'MOLA', false, pct),
    dubKnob('drift', 'FITA', false, pct),
    dubKnob('level', 'NÍVEL', false, pct),
    { kind: 'switch', k: 'dub.cut', label: 'CORTA A MÚSICA', get: () => dub().dry === 'cut', set: (on) => dubSettings.update({ dry: on ? 'cut' : 'keep' }) },
    { kind: 'switch', k: 'dub.fade', label: 'SOLTOU, MORRE', get: () => dub().release === 'fade', set: (on) => dubSettings.update({ release: on ? 'fade' : 'ring' }) },
    { kind: 'switch', k: 'dub.latch', label: 'TRAVAR DUB', get: () => dub().mode === 'latch', set: (on) => dubSettings.update({ mode: on ? 'latch' : 'hold' }) },
    { kind: 'do', k: 'dub.reset', label: 'VOLTAR AO PADRÃO', run: () => dubSettings.update({ ...DUB_PRESETS[0].settings }) },
  ],
}

// ───────── tape echo, weight, isolator ─────────
const ob = () => outboard.get()
const iso = () => isolator.get()
const fxSections: Section[] = [
  {
    title: 'Eco de fita',
    open: true,
    controls: [
      { kind: 'button', id: 'rack.throwA', label: 'THROW A', hold: true, lit: 'echo.throwA' },
      { kind: 'button', id: 'rack.throwB', label: 'THROW B', hold: true, lit: 'echo.throwB' },
      { kind: 'button', id: 'rack.tap', label: 'TAP' },
      { kind: 'button', id: 'rack.echoTail', label: 'CORTAR CAUDA' },
      {
        kind: 'choice',
        k: 'echo.division',
        label: 'DIVISÃO',
        options: DIVISIONS.map((d) => ({ v: d.id, label: d.id })),
        get: () => (ob().timeMode === 'sync' ? ob().division : ''),
        set: (v) => outboard.update({ division: v as (typeof DIVISIONS)[number]['id'], timeMode: 'sync' }),
      },
      knob('echo.feedback', 'REPETE', lin(0, 1.1), () => ob().feedback, (x) => outboard.update({ feedback: x }), pct),
      knob('echo.tone', 'TOM', lin(0, 1), () => ob().tone, (x) => outboard.update({ tone: x }), pct),
      knob('echo.wobble', 'FITA', lin(0, 1), () => ob().wobble, (x) => outboard.update({ wobble: x }), pct),
      knob('echo.spring', 'MOLA', lin(0, 1), () => ob().spring, (x) => outboard.update({ spring: x }), pct),
      knob('echo.level', 'NÍVEL', lin(0, 1), () => ob().echoLevel, (x) => outboard.update({ echoLevel: x }), pct),
      knob('echo.sendA', 'ENVIO A', lin(0, 1), () => ob().send.A, (x) => outboard.setSend('A', x), pct),
      knob('echo.sendB', 'ENVIO B', lin(0, 1), () => ob().send.B, (x) => outboard.setSend('B', x), pct),
      { kind: 'button', id: 'rack.crash', label: 'PANCADA NA MOLA' },
      {
        kind: 'do',
        k: 'echo.reset',
        label: 'VOLTAR AO PADRÃO',
        run: () => outboard.update({ division: '3/8', timeMode: 'sync', feedback: 0.55, tone: 0.45, wobble: 0.35, spring: 0.4, echoLevel: 0.8 }),
      },
    ],
  },
  {
    title: 'Sound system',
    controls: [
      knob('ss.weight', 'PESO', lin(0, 1), () => ob().weight, (x) => outboard.update({ weight: x }), (x) => '+' + (x * 9).toFixed(1) + ' dB'),
      knob('ss.weightHz', 'FREQ. PESO', lin(40, 120), () => ob().weightHz, (x) => outboard.update({ weightHz: x }), hz),
      { kind: 'button', id: 'rack.drop', label: 'DROP', lit: 'ss.dropping' },
      { kind: 'button', id: 'rack.autodub', label: 'DUB AUTO', lit: 'ss.autodub' },
      { kind: 'do', k: 'ss.reset', label: 'VOLTAR AO PADRÃO', run: () => outboard.update({ weight: 0.3, weightHz: 60 }) },
    ],
  },
  {
    title: 'Isolador do master',
    hint: 'tirar ou empurrar cada faixa',
    controls: [
      knob('iso.low', 'GRAVES', lin(0, 1.5), () => iso().low, (x) => isolator.update({ low: x }), pct),
      knob('iso.mid', 'MÉDIOS', lin(0, 1.5), () => iso().mid, (x) => isolator.update({ mid: x }), pct),
      knob('iso.top', 'AGUDOS', lin(0, 1.5), () => iso().top, (x) => isolator.update({ top: x }), pct),
      { kind: 'switch', k: 'iso.killLow', label: 'KILL GRAVE', get: () => iso().killLow, set: (on) => isolator.kill('low', on) },
      { kind: 'switch', k: 'iso.killMid', label: 'KILL MÉDIO', get: () => iso().killMid, set: (on) => isolator.kill('mid', on) },
      { kind: 'switch', k: 'iso.killTop', label: 'KILL AGUDO', get: () => iso().killTop, set: (on) => isolator.kill('top', on) },
      { kind: 'switch', k: 'iso.filterOn', label: 'FILTROS DO MASTER', get: () => iso().filterOn, set: (on) => isolator.update({ filterOn: on }) },
      knob('iso.hp', 'CORTE GRAVE', lin(0, 1), () => iso().hp, (x) => isolator.update({ hp: x, filterOn: true }), (x) => hz(20 * Math.pow(100, x))),
      { kind: 'do', k: 'iso.reset', label: 'TUDO RETO (PADRÃO)', run: () => isolator.reset() },
      knob('iso.lp', 'CORTE AGUDO', lin(0, 1), () => iso().lp, (x) => isolator.update({ lp: x, filterOn: true }), (x) => hz(20000 * Math.pow(250 / 20000, x))),
    ],
  },
]

// ───────── master: compressor, limiter, headphones ─────────
const dyn = () => mixer.get().dynamics
function dynKnob(field: keyof typeof LIMITS, label: string, logScale: boolean, show: (x: number) => string): Num {
  const [lo, hi] = LIMITS[field]
  return knob('dyn.' + field, label, logScale ? log(lo, hi) : lin(lo, hi), () => dyn()[field], (x) => mixer.setDynamics({ [field]: x, ...(field === 'ceiling' || field === 'limRelease' ? {} : { preset: null }) }), show)
}
const masterSections: Section[] = [
  {
    title: 'Compressor do master',
    open: true,
    controls: [
      { kind: 'switch', k: 'dyn.comp', label: 'COMPRESSOR', get: () => dyn().comp, set: (on) => mixer.setDynamics({ comp: on }) },
      {
        kind: 'choice',
        k: 'dyn.preset',
        label: 'PRONTO',
        options: COMP_PRESETS.map((p) => ({ v: p.name, label: p.name.toUpperCase() })),
        get: () => dyn().preset ?? '',
        set: (v) => {
          const p = COMP_PRESETS.find((x) => x.name === v)
          if (p) mixer.setDynamics({ ...p.set, preset: p.name, comp: true })
        },
      },
      dynKnob('threshold', 'LIMIAR', false, db),
      dynKnob('ratio', 'TAXA', true, (x) => x.toFixed(1) + ':1'),
      dynKnob('attack', 'ATAQUE', true, ms),
      dynKnob('release', 'SOLTURA', true, ms),
      dynKnob('makeup', 'GANHO', false, db),
      {
        kind: 'do',
        k: 'dyn.reset',
        label: 'VOLTAR AO PADRÃO',
        run: () => {
          const { threshold, ratio, attack, release, makeup, preset } = DYNAMICS_DEFAULT
          mixer.setDynamics({ threshold, ratio, attack, release, makeup, preset })
        },
      },
    ],
  },
  {
    title: 'Limiter',
    hint: 'o teto do som',
    controls: [
      { kind: 'switch', k: 'dyn.lim', label: 'LIMITER', get: () => dyn().lim, set: (on) => mixer.setDynamics({ lim: on }) },
      dynKnob('ceiling', 'TETO', false, db),
      dynKnob('limRelease', 'SOLTURA', true, ms),
      { kind: 'do', k: 'lim.reset', label: 'VOLTAR AO PADRÃO', run: () => mixer.setDynamics({ ceiling: DYNAMICS_DEFAULT.ceiling, limRelease: DYNAMICS_DEFAULT.limRelease }) },
    ],
  },
  {
    title: 'Headphone e crossfader',
    controls: [
      knob('hp.volume', 'VOLUME FONE', lin(0, 1), () => mixer.get().hpVolume, (x) => mixer.setHeadphoneVolume(x), pct),
      knob('hp.mix', 'CUE / MASTER', lin(0, 1), () => mixer.get().cueMix, (x) => mixer.setCueMix(x), (x) => (x < 0.05 ? 'só cue' : x > 0.95 ? 'só master' : pct(x))),
      {
        kind: 'choice',
        k: 'xf.curve',
        label: 'CURVA DO CROSSFADER',
        options: [
          { v: 'smooth', label: 'SUAVE' },
          { v: 'cut', label: 'CORTE' },
          { v: 'thru', label: 'DESLIGADO' },
        ],
        get: () => mixer.get().xfCurve,
        set: (v) => mixer.setCrossfaderCurve(v as 'smooth' | 'cut' | 'thru'),
      },
    ],
  },
]

/** Pages of the phone: their sections, in order. */
export const PANELS: Record<'dub' | 'fx' | 'mix', Section[]> = {
  dub: [...dubBoxSections, deckDub],
  fx: fxSections,
  mix: masterSections,
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
