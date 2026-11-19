import { midi } from './midi'

/**
 * Game controllers (a PlayStation DualShock 4 / DualSense over Bluetooth, an Xbox pad…) read through
 * the Gamepad API and fed to the same mappings as the MIDI controllers ("gp:b:<n>" buttons,
 * "gp:a:<n>" stick axes, standard layout). Only changes are passed on, read every frame while a pad
 * is connected. macOS shows the pad to the app after its first button press.
 */

const DEAD = 0.12 // stick dead zone: a stick at rest never moves anything
let raf = 0
let lastTime = 0
const last = new Map<string, number>()

function poll(time: number): void {
  raf = 0
  const dt = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 0
  lastTime = time
  const pads = navigator.getGamepads?.() ?? []
  let any: Gamepad | null = null
  for (const pad of pads) {
    if (!pad || !pad.connected) continue
    any ??= pad
    pad.buttons.forEach((b, i) => send('gp:b:' + i, b.value, false))
    pad.axes.forEach((a, i) => {
      // Up is negative in the Gamepad API: flipped, so pushing up means "more".
      const v = Math.abs(a) < DEAD ? 0 : i % 2 === 1 ? -a : a
      send('gp:a:' + i, v, true)
    })
  }
  if (dt) midi.padTick(dt)
  if (any) raf = requestAnimationFrame(poll)
  else lastTime = 0
}

function send(key: string, value: number, axis: boolean): void {
  const before = last.get(key) ?? 0
  if (Math.abs(value - before) < 0.01) return
  last.set(key, value)
  midi.fromGamepad(key, value, axis)
}

/** A readable name for the pad ("DUALSHOCK 4 Wireless Controller (STANDARD GAMEPAD …)" → "DUALSHOCK 4"). */
function nameOf(pad: Gamepad): string {
  const id = pad.id.replace(/\s*\(.*\)\s*$/, '').trim()
  if (/dualshock|054c.*0(5c4|9cc)/i.test(pad.id)) return 'DualShock 4'
  if (/dualsense|054c.*0ce6/i.test(pad.id)) return 'DualSense'
  return id || 'Gamepad'
}

function start(): void {
  const pad = (navigator.getGamepads?.() ?? []).find((p) => p && p.connected)
  midi.setGamepad(pad ? nameOf(pad) : null)
  if (pad && !raf) raf = requestAnimationFrame(poll)
}

if (typeof window !== 'undefined' && 'getGamepads' in navigator) {
  window.addEventListener('gamepadconnected', start)
  window.addEventListener('gamepaddisconnected', () => {
    last.clear()
    start()
  })
  start()
}
