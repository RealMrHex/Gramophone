/**
 * User settings (kept in localStorage — small and synchronous, so they apply before the first frame) and the
 * performance tier the app actually runs at.
 *
 * Visual quality "auto" watches how long frames take while music plays and steps down (never up, within a session)
 * on phones that can't keep up; the result is remembered for next launch.
 */
import { computed, reactive, watch } from 'vue'

export type Quality = 'auto' | 'high' | 'balanced' | 'saver'
export type Tier = Exclude<Quality, 'auto'>

const KEY = 'gramophone.settings', AUTO_KEY = 'gramophone.autoTier'
const load = <T>(k: string, fallback: T): T => {
  try { const v = localStorage.getItem(k); return v ? { ...fallback, ...JSON.parse(v) } : fallback } catch { return fallback }
}

export const settings = reactive(load(KEY, {
  /** film grain over the whole app */
  grain: true,
  /** melody / hooks / key / tempo analysis — off: a live visualizer instead of the note lanes */
  analysis: true,
  quality: 'auto' as Quality,
}))
watch(settings, s => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode */ } }, { deep: true })

// first guess for "auto" before anything is measured: small devices start one step down
function guess(): Tier {
  try { const t = localStorage.getItem(AUTO_KEY); if (t === 'high' || t === 'balanced' || t === 'saver') return t } catch { /* */ }
  const nav = navigator as Navigator & { deviceMemory?: number }
  const cores = nav.hardwareConcurrency || 8, mem = nav.deviceMemory || 8
  return cores <= 4 || mem <= 3 ? 'balanced' : 'high'
}
export const perf = reactive({ auto: guess() as Tier, frameMs: 0, samples: 0 })
export const tier = computed<Tier>(() => (settings.quality === 'auto' ? perf.auto : settings.quality))

/**
 * Feed real frame times (only while music plays and the app is on screen). Averaged over ~4 s; if frames are
 * consistently slow, "auto" drops a tier and starts measuring again.
 */
let acc = 0, n = 0
export function sampleFrame(dtMs: number) {
  if (dtMs <= 0 || dtMs > 200) return
  acc += dtMs; n++
  if (n < 240) return
  const avg = acc / n
  perf.frameMs = Math.round(avg * 10) / 10; perf.samples += n
  acc = 0; n = 0
  if (settings.quality !== 'auto') return
  const next: Tier | null = perf.auto === 'high' && avg > 19 ? 'balanced' : perf.auto === 'balanced' && avg > 22 ? 'saver' : null
  if (next) {
    perf.auto = next
    try { localStorage.setItem(AUTO_KEY, next) } catch { /* */ }
  }
}
export const tierLabel: Record<Tier, string> = { high: 'High', balanced: 'Balanced', saver: 'Battery saver' }
