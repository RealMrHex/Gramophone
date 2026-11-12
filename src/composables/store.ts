import { reactive, shallowRef } from 'vue'
import type { Analysis, Engine } from '../types'
import type { RecordLook } from '../render/palette'
import { onFrame } from './player'

export const analysis = shallowRef<Analysis | null>(null)
/** record look derived from the current track's cover art (null → default cosy record) */
export const look = shallowRef<RecordLook | null>(null)
/** prebuilt record texture for the track on the deck (null → the default cosy record) */
export const vinylTex = shallowRef<HTMLCanvasElement | null>(null)
export const meta = reactive({ title: 'Gramophone', hue: 330, engine: 'mix' as Engine, subtitle: '' })
export const active = reactive({ idx: -1, on: false, line: 0 })

export function resetActive() { active.idx = -1; active.on = false; active.line = 0 }

/**
 * Lighting cues. `flash` is set to a boom's strength the instant it is heard (the stage consumes it).
 * `kick` (camera scale punch) and `vig` (blood-red hit vignette) are envelopes the stage writes every frame.
 */
export const fx = { flash: 0, kick: 0, vig: 0 }
let bi = 0, lastHeard = 0
onFrame(c => {
  const B = analysis.value?.booms
  if (!B || !B.length) return
  // media time that is reaching the speakers right now
  const heard = c.t - c.latency
  if (heard < lastHeard - 0.05 || heard > lastHeard + 0.5) {
    let lo = 0, hi = B.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (B[m].t < heard) lo = m + 1; else hi = m }
    bi = lo
  }
  while (bi < B.length && B[bi].t <= heard) {
    if (c.playing && heard - B[bi].t < 0.12) fx.flash = Math.max(fx.flash, B[bi].s)
    bi++
  }
  lastHeard = heard
})

onFrame(c => {
  const a = analysis.value
  if (!a || !a.flat.length) return
  const T = a.flat, t = c.t
  let lo = 0, hi = T.length - 1, idx = -1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (T[m].t0 <= t) { idx = m; lo = m + 1 } else hi = m - 1
  }
  const on = idx >= 0 && t < T[idx].t1 + 0.02
  const line = idx < 0 ? 0 : T[idx].line
  if (idx !== active.idx) active.idx = idx
  if (on !== active.on) active.on = on
  if (line !== active.line) active.line = line
})
