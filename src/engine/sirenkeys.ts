import { dubBox } from './dubbox'
import { PATCH_LIMITS } from './dubbox'
import { clamp } from '../store'

/**
 * A MIDI keyboard plays the Dub Box like an instrument: each key is a note of the siren (or of the
 * loaded sound), the last key held wins and the pitch glides between keys (legato); the pitch wheel
 * bends it ±2 semitones and the modulation wheel sets how much it wobbles.
 */
class SirenKeys {
  private held: number[] = []
  private bend = 0 // semitones

  private hz(note: number): number {
    const [lo, hi] = PATCH_LIMITS.pitch
    return clamp(440 * Math.pow(2, (note - 69 + this.bend) / 12), lo, hi)
  }

  noteOn(note: number): void {
    this.held = [...this.held.filter((n) => n !== note), note]
    dubBox.updatePatch({ pitch: this.hz(note) })
    // First key: start the sound; more keys while it sounds just move the pitch.
    if (!dubBox.get().playing) dubBox.trigger()
  }

  noteOff(note: number): void {
    this.held = this.held.filter((n) => n !== note)
    const last = this.held.at(-1)
    if (last !== undefined) dubBox.updatePatch({ pitch: this.hz(last) })
    else if (dubBox.get().playing) dubBox.release()
  }

  /** Pitch wheel, -1..1. */
  pitchWheel(v: number): void {
    this.bend = v * 2
    const last = this.held.at(-1)
    if (last !== undefined) dubBox.updatePatch({ pitch: this.hz(last) })
  }

  /** Modulation wheel, 0..1: wobble depth up to an octave. */
  modWheel(v: number): void {
    dubBox.updatePatch({ lfoDepth: v * 12 })
  }
}

export const sirenKeys = new SirenKeys()
