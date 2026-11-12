import { FFT } from './fft'

export interface Tempo {
  bpm: number
  /** peak-to-mean ratio of the tempo score; ~1 means no clear pulse */
  confidence: number
}

/**
 * Global tempo from the audio itself (independent of the melody tracker):
 *  1. onset strength = spectral flux of log-magnitude STFT (1024 / hop 256), local-mean removed, half-wave rectified
 *  2. autocorrelation of the onset curve over 55–200 BPM lags
 *  3. harmonic comb (lag, 2·lag, 3·lag, 4·lag, lag/2) so the true beat period beats its subdivisions and 1.5× periods
 *  4. log-normal tempo prior around 120 BPM to settle half/double-time ambiguity
 */
export interface Boom {
  /** seconds */
  t: number
  /** 0..1 */
  s: number
}

interface Flux { flux: Float32Array; low: Float32Array; fps: number; F: number; t0: number }

/** One STFT pass → full-band and low-band (kick/bass, < ~160 Hz) spectral flux. */
function spectralFlux(x: Float32Array, fs: number): Flux | null {
  const N = 1024, hop = 256, half = N / 2
  const F = Math.floor((x.length - N) / hop)
  const fps = fs / hop
  if (F < fps * 4) return null // need a few seconds

  const fft = new FFT(N)
  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
  const re = new Float32Array(N), im = new Float32Array(N)
  let prev = new Float32Array(half), cur = new Float32Array(half)
  const kMax = Math.min(half, Math.ceil(10000 / (fs / N)))
  const kLow = Math.max(2, Math.round(160 / (fs / N)))
  const flux = new Float32Array(F), low = new Float32Array(F)
  for (let f = 0; f < F; f++) {
    const o = f * hop
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0 }
    fft.transform(re, im)
    let s = 0, sl = 0
    for (let k = 1; k < kMax; k++) {
      const m = Math.log1p(100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]))
      cur[k] = m
      const d = m - prev[k]
      if (d > 0) { s += d; if (k <= kLow) sl += d }
    }
    flux[f] = f ? s : 0
    low[f] = f ? sl : 0
    const t = prev; prev = cur; cur = t
  }
  return { flux, low, fps, F, t0: N / 2 / fs }
}

/** Tempo + "booms" (kick / bass hits) from a single analysis pass. */
export function analyzeRhythm(x: Float32Array, fs: number): { tempo: Tempo | null; booms: Boom[] } {
  const fl = spectralFlux(x, fs)
  if (!fl) return { tempo: null, booms: [] }
  return { tempo: tempoFromFlux(fl), booms: detectBooms(fl, x.length / fs) }
}

/**
 * Peak-pick an onset curve with an adaptive threshold (local mean + 1.4·std over ±1.5 s), a ±50 ms local-max
 * window and a 180 ms refractory gap. Uses the low band (kicks / 808s); if a track has hardly any low hits
 * (e.g. a solo melody) it falls back to the full band so the lights still follow the music.
 */
function detectBooms({ flux, low, fps, F, t0 }: Flux, duration: number): Boom[] {
  const pick = (src: Float32Array, gain: number): Boom[] => {
    const sm = new Float32Array(F)
    for (let f = 1; f < F - 1; f++) sm[f] = (src[f - 1] + 2 * src[f] + src[f + 1]) / 4
    const sorted = Float32Array.from(sm).sort()
    const p98 = sorted[Math.floor(F * 0.98)] || 1
    const top = sorted[Math.floor(F * 0.995)] || p98
    const pre = new Float64Array(F + 1), pre2 = new Float64Array(F + 1)
    for (let f = 0; f < F; f++) { pre[f + 1] = pre[f] + sm[f]; pre2[f + 1] = pre2[f] + sm[f] * sm[f] }
    const W = Math.round(1.5 * fps), L = Math.max(1, Math.round(0.05 * fps)), gap = 0.18
    const out: Boom[] = []
    for (let f = L; f < F - L; f++) {
      const v = sm[f]
      if (v < 0.12 * p98) continue
      let isMax = true
      for (let j = -L; j <= L; j++) if (sm[f + j] > v) { isMax = false; break }
      if (!isMax) continue
      const a = Math.max(0, f - W), b = Math.min(F, f + W + 1), n = b - a
      const mean = (pre[b] - pre[a]) / n, sd = Math.sqrt(Math.max(0, (pre2[b] - pre2[a]) / n - mean * mean))
      if (v < mean + 1.4 * sd) continue
      const t = f / fps + t0
      if (out.length && t - out[out.length - 1].t < gap) continue
      // curve so only the biggest hits approach 1 (the lighting maps strength² to brightness)
      out.push({ t, s: Math.min(1, Math.pow(v / top, 1.5) * gain) })
    }
    return out
  }
  let booms = pick(low, 1)
  // melodic material: note attacks stand in for booms, but much softer so they don't pump the lights constantly
  if (booms.length < duration / 6) booms = pick(flux, 0.4)
  return booms
}

function tempoFromFlux({ flux, fps, F }: Flux): Tempo | null {
  // remove slow loudness changes, keep the transients
  const w = Math.max(1, Math.round(0.3 * fps))
  const pre = new Float64Array(F + 1)
  for (let f = 0; f < F; f++) pre[f + 1] = pre[f] + flux[f]
  const raw = new Float32Array(F)
  for (let f = 0; f < F; f++) {
    const a = Math.max(0, f - w), b = Math.min(F, f + w + 1)
    const v = flux[f] - (pre[b] - pre[a]) / (b - a)
    raw[f] = v > 0 ? v : 0
  }
  // widen the one-frame onset spikes a little so beat periods that fall between integer lags still correlate
  const K = [1, 3, 4, 3, 1], KS = 12
  const onset = new Float32Array(F)
  let sq = 0
  for (let f = 0; f < F; f++) {
    let v = 0
    for (let j = -2; j <= 2; j++) { const q = f + j; if (q >= 0 && q < F) v += raw[q] * K[j + 2] }
    onset[f] = v / KS
    sq += onset[f] * onset[f]
  }
  const norm = Math.sqrt(sq / F) || 1
  for (let f = 0; f < F; f++) onset[f] /= norm

  const lagMin = Math.floor((60 * fps) / 200), lagMax = Math.ceil((60 * fps) / 55)
  const acMax = Math.min(F - 1, lagMax * 4 + 2)
  const ac = new Float32Array(acMax + 1)
  for (let l = lagMin; l <= acMax; l++) {
    let s = 0
    for (let f = 0; f + l < F; f++) s += onset[f] * onset[f + l]
    ac[l] = s / (F - l)
  }
  const at = (l: number) => {
    // linear interpolation for fractional lags
    const i = Math.floor(l), fr = l - i
    if (i + 1 > acMax) return 0
    return ac[i] * (1 - fr) + ac[i + 1] * fr
  }
  const score = new Float32Array(lagMax + 2)
  let best = -1, bestL = lagMin, sum = 0, n = 0
  for (let l = lagMin; l <= lagMax; l++) {
    // multiples confirm the period; the half-period term rewards duple subdivision, which rejects 1.5-beat periods
    const comb = at(l) + 0.5 * at(2 * l) + 0.33 * at(3 * l) + 0.25 * at(4 * l) + 0.5 * at(l / 2)
    const bpm = (60 * fps) / l
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2))
    score[l] = comb * prior
    sum += score[l]; n++
    if (score[l] > best) { best = score[l]; bestL = l }
  }
  // parabolic refinement of the winning lag
  let lag = bestL
  if (bestL > lagMin && bestL < lagMax) {
    const a = score[bestL - 1], b = score[bestL], c = score[bestL + 1], den = a - 2 * b + c
    if (den) lag = bestL + (0.5 * (a - c)) / den
  }
  return { bpm: Math.round((600 * fps) / lag) / 10, confidence: best / (sum / n || 1) }
}
