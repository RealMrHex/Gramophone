import type { WorkerIn, WorkerOut } from '../types'
import { extractMelody } from './melody'
import { trackYin } from './yin'
import { buildPhrases } from './phrases'
import { analyzeRhythm } from './tempo'

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m)

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  try {
    const { mono, fs, engine } = ev.data
    const stage = engine === 'mix' ? 'tracking melody' : 'tracking pitch'
    const progress = (p: number) => post({ type: 'progress', p, stage })
    const notes = engine === 'mix' ? extractMelody(mono, fs, progress) : trackYin(mono, fs, progress)
    post({ type: 'progress', p: 1, stage: 'finding the beat' })
    const { tempo, booms } = analyzeRhythm(mono, fs)
    post({ type: 'progress', p: 1, stage: 'finding hooks' })
    const result = buildPhrases(notes, engine, tempo && tempo.confidence > 1.15 ? tempo.bpm : undefined)
    result.booms = booms
    post({ type: 'done', result })
  } catch (e) {
    post({ type: 'error', message: (e as Error).message })
  }
}
