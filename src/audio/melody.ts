import type { Note } from '../types'
import { FFT } from './fft'
import { mtof } from './music'

export interface MelodyDebug { frames: number; voiced: number; tuning: number; p95: number }

/**
 * Melody extraction for full mixes (vocal / lead line on top of drums + bass).
 *
 *  1. STFT (4096 @ ~22 kHz) and spectral-peak enhancement (subtract the local spectral mean),
 *     which suppresses broadband drums and keeps tonal partials.
 *  2. Harmonic-sum salience over 1/3-semitone pitch candidates (C3..B5) with a mild
 *     register prior that favours the vocal/lead range over sub-bass.
 *  3. Viterbi tracking with a pitch-jump penalty - kills octave flips and spurious jumps.
 *  4. Voicing decision, tuning correction, then segmentation into discrete notes.
 */
export function extractMelody(x: Float32Array, fs: number, progress: (p: number) => void, debug?: MelodyDebug): Note[] {
  const N = 4096, hop = 512, half = N / 2
  const F = Math.floor((x.length - N) / hop)
  if (F < 8) return []
  const hopT = hop / fs, binHz = fs / N

  const midiLo = 52, midiHi = 84, PB = 3, nC = (midiHi - midiLo) * PB + 1
  const NH = 9
  const hw = new Float32Array(NH)
  for (let h = 0; h < NH; h++) hw[h] = Math.pow(0.82, h)
  const pos = new Float32Array(nC * NH)
  const prior = new Float32Array(nC)
  for (let i = 0; i < nC; i++) {
    const m = midiLo + i / PB, f0 = mtof(m)
    for (let h = 0; h < NH; h++) { const p = ((h + 1) * f0) / binHz; pos[i * NH + h] = p < half - 2 ? p : -1 }
    prior[i] = 0.5 + 0.5 * Math.exp(-0.5 * Math.pow((m - 67) / 9, 2))
  }

  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
  const fft = new FFT(N)
  const re = new Float32Array(N), im = new Float32Array(N)
  const comp = new Float32Array(half), e = new Float32Array(half), pre = new Float64Array(half + 1)
  const sal = new Float32Array(F * nC), peak = new Float32Array(F)
  const kMin = Math.ceil(90 / binHz), W = 26

  for (let f = 0; f < F; f++) {
    if (f % 150 === 0) progress((f / F) * 0.8)
    const o = f * hop
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0 }
    fft.transform(re, im)
    for (let k = 0; k < half; k++) comp[k] = Math.pow(re[k] * re[k] + im[k] * im[k], 0.3) // power^0.3 ~ mag^0.6
    pre[0] = 0
    for (let k = 0; k < half; k++) pre[k + 1] = pre[k] + comp[k]
    for (let k = 0; k < half; k++) {
      const a = Math.max(0, k - W), b = Math.min(half, k + W + 1)
      const avg = (pre[b] - pre[a]) / (b - a)
      e[k] = k < kMin ? 0 : Math.max(0, comp[k] - 1.15 * avg)
    }
    let pk = 0
    const base = f * nC
    for (let i = 0; i < nC; i++) {
      let s = 0
      for (let h = 0; h < NH; h++) {
        const p = pos[i * NH + h]
        if (p < 0) break
        const k = p | 0, fr = p - k
        s += hw[h] * (e[k] * (1 - fr) + e[k + 1] * fr)
      }
      s *= prior[i]
      sal[base + i] = s
      if (s > pk) pk = s
    }
    peak[f] = pk
  }

  const sortedPeak = Float32Array.from(peak).sort()
  const p95 = sortedPeak[Math.floor(F * 0.95)] || 1
  const inv = 1 / p95
  for (let i = 0; i < sal.length; i++) sal[i] = Math.min(1.6, sal[i] * inv)

  // Viterbi
  progress(0.82)
  const MAXJ = 9, lam = 0.07
  const back = new Int8Array(F * nC)
  let cur = new Float32Array(nC), nxt = new Float32Array(nC)
  for (let i = 0; i < nC; i++) cur[i] = -sal[i]
  for (let f = 1; f < F; f++) {
    const base = f * nC
    for (let i = 0; i < nC; i++) {
      let best = Infinity, arg = 0
      const lo = Math.max(-MAXJ, -i), hi = Math.min(MAXJ, nC - 1 - i)
      for (let d = lo; d <= hi; d++) {
        const c = cur[i + d] + lam * Math.abs(d)
        if (c < best) { best = c; arg = d }
      }
      nxt[i] = best - sal[base + i]
      back[base + i] = arg
    }
    const t = cur; cur = nxt; nxt = t
  }
  const path = new Int16Array(F)
  let bi = 0
  for (let i = 1; i < nC; i++) if (cur[i] < cur[bi]) bi = i
  for (let f = F - 1; f >= 0; f--) { path[f] = bi; bi += back[f * nC + bi] }

  // voicing
  progress(0.9)
  const voiced = new Uint8Array(F)
  const nPeak = new Float32Array(F)
  for (let f = 0; f < F; f++) {
    nPeak[f] = peak[f] * inv
    const at = sal[f * nC + path[f]]
    voiced[f] = nPeak[f] > 0.28 && at > 0.2 ? 1 : 0
  }
  for (let f = 1; f < F - 1; f++) if (!voiced[f] && voiced[f - 1] && voiced[f + 1]) voiced[f] = 1
  for (let f = 1; f < F - 1; f++) if (voiced[f] && !voiced[f - 1] && !voiced[f + 1]) voiced[f] = 0

  // tuning offset (circular mean of fractional semitone)
  let sx = 0, sy = 0, nv = 0
  for (let f = 0; f < F; f++) if (voiced[f]) {
    const fr = (path[f] / PB) % 1
    sx += Math.cos(2 * Math.PI * fr); sy += Math.sin(2 * Math.PI * fr); nv++
  }
  const tuning = nv ? Math.atan2(sy, sx) / (2 * Math.PI) : 0
  const mf = new Float32Array(F)
  for (let f = 0; f < F; f++) mf[f] = midiLo + path[f] / PB - tuning
  // median smooth
  const ms = new Float32Array(F)
  for (let f = 0; f < F; f++) {
    if (!voiced[f]) continue
    const v: number[] = []
    for (let k = -2; k <= 2; k++) if (voiced[f + k] && f + k >= 0 && f + k < F) v.push(mf[f + k])
    v.sort((a, b) => a - b)
    ms[f] = v[v.length >> 1]
  }
  // energy dips -> note boundaries for repeated same-pitch notes
  const brk = new Uint8Array(F)
  for (let f = 2; f < F - 2; f++) {
    const l = Math.max(peak[f - 2], peak[f - 1]), r = Math.max(peak[f + 1], peak[f + 2])
    if (peak[f] < 0.5 * l && peak[f] < 0.5 * r && peak[f] <= peak[f - 1] && peak[f] <= peak[f + 1]) brk[f] = 1
  }

  // segment into notes
  const notes: Note[] = []
  let c: { sum: number; n: number; start: number; end: number } | null = null
  const t0Of = (f: number) => (f * hop + half - hop / 2) / fs
  const t1Of = (f: number) => (f * hop + half + hop / 2) / fs
  const MIN = 4
  const flush = () => {
    if (c && c.n >= MIN) {
      const m = Math.round(c.sum / c.n)
      const last = notes[notes.length - 1]
      let dip = false
      if (last) for (let q = Math.floor(last.t1 / hopT) - 1; q <= c.start; q++) if (brk[q]) dip = true
      if (last && last.midi === m && c.start * hopT - last.t1 < 0.06 && !dip) last.t1 = t1Of(c.end)
      else notes.push({ midi: m, t0: t0Of(c.start), t1: t1Of(c.end) })
    }
    c = null
  }
  for (let f = 0; f < F; f++) {
    if (!voiced[f]) { flush(); continue }
    const m = ms[f]
    if (c && Math.abs(m - c.sum / c.n) < 0.7 && !brk[f]) { c.sum += m; c.n++; c.end = f }
    else { flush(); c = { sum: m, n: 1, start: f, end: f } }
  }
  flush()
  progress(1)
  if (debug) { debug.frames = F; debug.voiced = nv; debug.tuning = tuning; debug.p95 = p95 }
  return notes
}
