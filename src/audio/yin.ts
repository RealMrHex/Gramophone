import type { Note } from '../types'
import { median } from './music'

/** Monophonic pitch tracker (YIN). Best for solo instruments, vocals, whistling, synth leads. */
export function trackYin(mono: Float32Array, fs0: number, progress: (p: number) => void): Note[] {
  const dec = Math.max(1, Math.round(fs0 / 11025)), fs = fs0 / dec, n = Math.floor(mono.length / dec)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < dec; k++) s += mono[i * dec + k]; x[i] = s / dec }
  const W = 512, hop = 256, tauMin = Math.floor(fs / 1200), tauMax = Math.ceil(fs / 70)
  const F = Math.max(0, Math.floor((n - W - tauMax) / hop)), hopT = hop / fs
  const rms = new Float32Array(F), midi: (number | null)[] = new Array(F).fill(null)
  for (let f = 0; f < F; f++) {
    const o = f * hop + W / 2 - hop / 2; let e = 0
    for (let j = 0; j < hop; j++) { const v = x[o + j]; e += v * v }
    rms[f] = Math.sqrt(e / hop)
  }
  const sorted = Float32Array.from(rms).sort(), p95 = sorted[Math.floor(F * 0.95)] || 0
  const gate = Math.max(0.004, p95 * 0.1)
  const cm = new Float32Array(tauMax + 2)
  for (let f = 0; f < F; f++) {
    if (f % 400 === 0) progress(f / F)
    if (rms[f] < gate) continue
    const off = f * hop
    let run = 0
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let s = 0
      for (let j = 0; j < W; j++) { const v = x[off + j] - x[off + j + tau]; s += v * v }
      run += s; cm[tau] = (s * tau) / (run || 1)
    }
    let tau = -1
    for (let t = tauMin; t <= tauMax; t++) if (cm[t] < 0.15) { while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++; tau = t; break }
    if (tau < 0) {
      let best = 1, bt = -1
      for (let t = tauMin; t <= tauMax; t++) if (cm[t] < best) { best = cm[t]; bt = t }
      if (best < 0.28) tau = bt
    }
    if (tau < 0) continue
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a - 2 * b + c
    const tp = den ? tau + (0.5 * (a - c)) / den : tau
    midi[f] = Math.round(69 + 12 * Math.log2(fs / tp / 440))
  }
  const sm = midi.map((m, f) => {
    if (m == null) return null
    const v: number[] = []
    for (let k = -2; k <= 2; k++) { const q = midi[f + k]; if (q != null) v.push(q) }
    return median(v)
  })
  const brk = new Uint8Array(F)
  for (let f = 2; f < F - 2; f++) {
    const l = Math.max(rms[f - 2], rms[f - 1]), r = Math.max(rms[f + 1], rms[f + 2])
    if (rms[f] < 0.6 * l && rms[f] < 0.6 * r && rms[f] <= rms[f - 1] && rms[f] <= rms[f + 1]) brk[f] = 1
  }
  const notes: Note[] = []
  let cur: { m: number; start: number; end: number } | null = null
  const close = () => {
    if (cur && cur.end - cur.start + 1 >= 3) notes.push({ midi: cur.m, t0: cur.start * hopT + 0.012, t1: (cur.end + 1) * hopT + 0.012 })
    cur = null
  }
  for (let f = 0; f < F; f++) {
    const m = sm[f]
    if (m == null) { close(); continue }
    if (cur && m === cur.m && !brk[f]) cur.end = f
    else { close(); cur = { m, start: f, end: f } }
  }
  close()
  progress(1)
  return notes
}
