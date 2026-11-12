import type { Analysis, Engine, WorkerIn, WorkerOut } from '../types'

export const TARGET_FS = 22050

/** Decode a blob and fold it to mono ~22 kHz (what the analysis worker expects). */
export async function decodeToMono(blob: Blob): Promise<{ mono: Float32Array; fs: number; duration: number }> {
  const ab = await blob.arrayBuffer()
  const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(ab)
  const dec = Math.max(1, Math.round(buf.sampleRate / TARGET_FS))
  const n = Math.floor(buf.length / dec)
  const mono = new Float32Array(n)
  const CHUNK = 400_000 // ≈ a few ms of work per slice; yield between slices so playback stays smooth
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c), w = 1 / dec / buf.numberOfChannels
    for (let i0 = 0; i0 < n; i0 += CHUNK) {
      const i1 = Math.min(n, i0 + CHUNK)
      for (let i = i0; i < i1; i++) {
        let s = 0
        for (let k = 0; k < dec; k++) s += d[i * dec + k]
        mono[i] += s * w
      }
      await new Promise(r => setTimeout(r, 0))
    }
  }
  return { mono, fs: buf.sampleRate / dec, duration: buf.duration }
}

export function analyze(mono: Float32Array, fs: number, engine: Engine, onProgress: (p: number, stage: string) => void): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data
      if (m.type === 'progress') onProgress(m.p, m.stage)
      else if (m.type === 'done') { w.terminate(); resolve(m.result) }
      else { w.terminate(); reject(new Error(m.message)) }
    }
    w.onerror = e => { w.terminate(); reject(new Error(e.message)) }
    const msg: WorkerIn = { mono: mono.slice(), fs, engine } // copy so the original can be re-analysed
    w.postMessage(msg)
  })
}
