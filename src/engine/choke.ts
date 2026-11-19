/**
 * PANIC helper: an echo's feedback held at zero long enough for everything inside the delay line
 * (up to its 4 s maximum) to pass out once and die, then back to where it was.
 */
export function choke(param: AudioParam, ctx: BaseAudioContext, ms = 4500): void {
  const back = param.value
  const now = ctx.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(0, now)
  param.setTargetAtTime(back, now + ms / 1000, 0.2)
}
