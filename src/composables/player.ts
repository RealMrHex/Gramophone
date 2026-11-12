import { ref } from 'vue'

export interface Clock {
  t: number
  dt: number
  /** audio is actually sounding */
  playing: boolean
  ended: boolean
  duration: number
  progress: number
  /** platter motor on: true from the moment play is pressed (the record spins up while the arm cues) */
  motor: boolean
  /** stylus radius in record radii (rest position when parked) */
  armR: number
  /** 0 = needle in the groove, 1 = fully lifted (can briefly dip below 0 on touch-down) */
  lift: number
  /** needle is down and following the audio clock */
  tracking: boolean
  /** platter speed override in rad/s while backspinning (null otherwise) */
  spin: number | null
  /** smoothed low-end energy 0..1 */
  bass: number
  /** smoothed overall energy 0..1 */
  level: number
  /** realtime kick estimate (fallback when no offline boom map exists) */
  beat: number
  /** seconds of output latency to compensate visual sync */
  latency: number
  spec: Float32Array
}

export const TICKS = 72
export const REST_R = 1.14
/**
 * groove radius for a playback position: lead-in at 0.96R, run-out at 0.41R — just outside the label (0.37R) —
 * so the needle has crossed the whole playing surface when the track ends, like a real side.
 */
export const LEAD_IN = 0.96
export const RUN_OUT = 0.41
export const grooveR = (p: number) => LEAD_IN + (RUN_OUT - LEAD_IN) * Math.min(1, Math.max(0, p))

export const clock: Clock = {
  t: 0, dt: 0.016, playing: false, ended: false, duration: 1, progress: 0,
  motor: false, armR: REST_R, lift: 1, tracking: false, spin: null,
  bass: 0, level: 0, beat: 0, latency: 0, spec: new Float32Array(TICKS),
}

type Cb = (c: Clock) => void
const cbs = new Set<Cb>()
export const onFrame = (cb: Cb) => { cbs.add(cb); return () => { cbs.delete(cb) } }

export const audio = new Audio()
audio.preload = 'auto'
/** UI intent: true while playing *or* while the arm is cueing up to play */
export const playing = ref(false)
export const duration = ref(0)
export const fmt = (t: number) => { t = Math.max(0, t | 0); return `${(t / 60) | 0}:${String(t % 60).padStart(2, '0')}` }

let actx: AudioContext | null = null
let analyser: AnalyserNode | null = null
/** master gain for the music, so stops/resumes around a backspin fade instead of clicking */
let main: GainNode | null = null
let fdata: Float32Array<ArrayBuffer> | null = null
/** analyser bin range per ring tick: log-spaced 40 Hz … 16 kHz */
let bands: { lo: number; hi: number; tilt: number }[] = []

function ensureAudio() {
  if (actx) return
  actx = new AudioContext()
  const src = actx.createMediaElementSource(audio)
  analyser = actx.createAnalyser()
  analyser.fftSize = 4096
  analyser.smoothingTimeConstant = 0.45
  analyser.minDecibels = -100; analyser.maxDecibels = -10
  main = actx.createGain()
  src.connect(main); main.connect(analyser); analyser.connect(actx.destination)
  fdata = new Float32Array(analyser.frequencyBinCount)
  const binHz = actx.sampleRate / analyser.fftSize, n = analyser.frequencyBinCount
  bands = Array.from({ length: TICKS }, (_, i) => {
    const f0 = 40 * Math.pow(400, i / TICKS), f1 = 40 * Math.pow(400, (i + 1) / TICKS)
    const lo = Math.min(n - 1, Math.max(1, Math.floor(f0 / binHz))), hi = Math.min(n - 1, Math.max(lo, Math.ceil(f1 / binHz) - 1))
    // music falls ~3 dB/octave toward the treble; tilt it back up so the whole ring moves, not just the bass
    return { lo, hi, tilt: 3 * Math.log2(Math.sqrt(f0 * f1) / 120) }
  })
}

// ── the deck: playback is driven through the tonearm ─────────────────────────────────────────────
//  rest   → parked off the record
//  cue    → lift, swing to the groove for the current position
//  lower  → drop the needle; audio starts the moment it touches
//  play   → needle down, radius locked to the audio clock
//  hold   → paused: needle lifted, hovering over its groove (follows seeks)
//  return → lift and swing back to rest (track ended / new track)
//  rewind → going back while playing: DJ backspin — needle stays down and rides outward with the reversed sound
//  brake  → pause while playing: platter and sound slow down together (pitch drops), then the needle lifts
type Phase = 'rest' | 'cue' | 'lower' | 'play' | 'hold' | 'return' | 'rewind' | 'brake'
const BRAKE = 0.5
const brk = { t: 0 }
/** platter speed (rad/s) at normal play — the stage's visual SPIN */
const PLATTER = 1.15
const brakeRate = (k: number) => Math.pow(1 - Math.min(1, Math.max(0, k)), 1.5)
const deck = { phase: 'rest' as Phase, want: false, armR: REST_R, lift: 1, liftV: 0, plat: 0 }
const rw = { from: 0, to: 0, t: 0, dur: 0.6 }
/**
 * Backspin shape over 0..1, like a hand shoving the platter back: full speed almost instantly (~5% attack),
 * then a smooth friction slowdown to a stop. Drives the platter, the reversed audio's playback rate and the needle.
 */
const spinShape = (k: number) => {
  const x = Math.min(1, Math.max(0, k))
  return Math.min(1, x / 0.05) * Math.pow(1 - x, 1.6)
}
/** fraction of the backspin's travel done at k (∫ spinShape, normalised) */
const spinTravel = (k: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 2.6)
const SPIN_PEAK = 2.6

// decoded mono PCM of the current track, used to synthesise the backspin sound from the real music
let pcm: { mono: Float32Array; fs: number } | null = null
/** the decoded song, for the reversed backspin sound (null when analysis is off: the backspin is then silent) */
export const setPcm = (mono: Float32Array | null, fs = 44100) => { pcm = mono ? { mono, fs } : null }
let sfx: { stop: () => void } | null = null

const syncState = () => { playing.value = deck.want }
audio.addEventListener('loadedmetadata', () => { duration.value = audio.duration })
audio.addEventListener('durationchange', () => { duration.value = audio.duration })
audio.addEventListener('ended', () => { deck.want = false; deck.phase = 'return'; syncState() })

const posR = (t: number) => grooveR(audio.duration ? t / audio.duration : 0)

export function loadSource(blob: Blob) {
  audio.pause()
  if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src)
  audio.src = URL.createObjectURL(blob)
  audio.currentTime = 0
  deck.want = false
  deck.phase = 'return'
  syncState()
}
/** Take the record off: stop, park the arm, forget the source (used when a playlist is cleared). */
export function unloadSource() {
  audio.pause()
  if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src)
  audio.removeAttribute('src'); audio.load()
  sfx?.stop(); sfx = null
  pcm = null
  deck.want = false
  if (deck.phase !== 'rest') deck.phase = 'return'
  syncState()
}
/** dip the music out over `sec` (used before switching tracks); resolves when silent */
export function fadeOut(sec = 0.16): Promise<void> {
  if (!main || !actx || audio.paused) return Promise.resolve()
  const n = actx.currentTime
  main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(main.gain.value, n); main.gain.linearRampToValueAtTime(0, n + sec)
  return new Promise(r => setTimeout(r, sec * 1000 + 10))
}
/** 0..1, applied to the music and to the backspin sound */
export function setVolume(v: number) { audio.volume = Math.min(1, Math.max(0, v)) }

/**
 * True when nothing is being drawn: the tab is hidden, or (Android WebView with the screen off / app in the
 * background, which still reports "visible") no animation frame has run for a while. The deck's arm and brake are
 * animated per frame, so in this state play / pause act immediately instead.
 */
let lastFrameAt = 0
export const inBackground = () => document.hidden || performance.now() - lastFrameAt > 400
// safety net: if the screen went off in the middle of an animated arm move or brake, finish it without frames
setInterval(() => {
  if (!inBackground()) return
  if (deck.phase === 'brake') {
    audio.pause(); audio.playbackRate = 1
    if (main && actx) { const n = actx.currentTime; main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(1, n) }
    deck.phase = 'hold'; syncState()
  } else if ((deck.phase === 'cue' || deck.phase === 'lower') && deck.want) {
    if (main && actx) { const n = actx.currentTime; main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(1, n) }
    deck.phase = 'play'; deck.lift = 0; deck.armR = posR(audio.currentTime)
    audio.play().catch(() => { deck.want = false; deck.phase = 'hold'; syncState() })
    syncState()
  }
}, 500)
export function play() {
  ensureAudio()
  // resume inside the click (user gesture); don't block the deck on it — the needle takes ~1 s to land anyway
  void actx!.resume()
  if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.05)) audio.currentTime = 0
  deck.want = true
  // app in the background (screen off, another app, lock-screen controls): there are no animation frames to run the
  // arm, so skip the cue and start the music now — the arm is simply on the groove when you come back
  if (inBackground()) {
    audio.playbackRate = 1
    if (main && actx) { const n = actx.currentTime; main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(1, n) }
    deck.phase = 'play'; deck.lift = 0; deck.armR = posR(audio.currentTime)
    audio.play().catch(() => { deck.want = false; deck.phase = 'hold'; syncState() })
    syncState()
    return
  }
  if (deck.phase === 'brake') {
    // changed our mind mid-brake: let the motor pull it straight back up to speed
    audio.playbackRate = 1
    if (main && actx) { const n = actx.currentTime; main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(main.gain.value, n); main.gain.linearRampToValueAtTime(1, n + 0.08) }
    deck.phase = 'play'
  } else if (deck.phase !== 'play' && deck.phase !== 'rewind') deck.phase = 'cue'
  syncState()
}
export function pause() {
  deck.want = false
  // the brake is animated frame by frame — in the background just stop
  const bg = inBackground()
  if (bg && deck.phase === 'brake') deck.phase = 'play'
  if (deck.phase === 'play' && !audio.paused && !bg) {
    // stop button: brake platter + sound together; updateDeck finishes the pause
    deck.phase = 'brake'; brk.t = 0
    audio.preservesPitch = false
    syncState()
    return
  }
  audio.pause()
  audio.playbackRate = 1
  if (main && actx) { const n = actx.currentTime; main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(1, n) }
  sfx?.stop(); sfx = null
  if (deck.phase !== 'rest' && deck.phase !== 'return') deck.phase = 'hold'
  syncState()
}
export const toggle = () => (deck.want ? pause() : play())
/**
 * Jump to `t`. With `smooth` (scrubber / ring) it's a quick crossfade: the sound dips for ~40 ms, the needle
 * glides to its new groove and playback never stops. Without it, going back while playing is a DJ backspin
 * and a big jump forward lifts, moves and re-drops the needle.
 */
export function seek(t: number, opts: { smooth?: boolean } = {}) {
  const d = audio.duration || 0
  t = Math.max(0, Math.min(d, t))
  const from = audio.currentTime
  const jump = Math.abs(posR(t) - posR(from))
  if (opts.smooth && deck.phase === 'play' && main && actx) {
    const n = actx.currentTime
    main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(main.gain.value, n); main.gain.linearRampToValueAtTime(0, n + 0.035)
    setTimeout(() => {
      audio.currentTime = t
      const m = actx!.currentTime
      main!.gain.cancelScheduledValues(m); main!.gain.setValueAtTime(0, m); main!.gain.linearRampToValueAtTime(1, m + 0.12)
    }, 40)
    return
  }
  // already backspinning (e.g. dragging on the ring): just retarget
  if (deck.phase === 'rewind') { rw.to = t; return }
  if (deck.phase === 'play' && t < from - 0.3) { startRewind(from, t, jump); return }
  audio.currentTime = t
  if (deck.phase !== 'play') return
  // a big jump forward while the needle is down: lift, move, drop, then resume — like a real deck.
  // small nudges (tiny radius change) just slide, so ±5 s on a long track doesn't stutter.
  else if (jump > 0.012) { audio.pause(); deck.phase = 'cue' }
}

function startRewind(from: number, to: number, jump: number) {
  // duck the music over ~25 ms, then pause + jump, so the hand-on-the-record moment doesn't click
  if (main && actx) { const n = actx.currentTime; main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(main.gain.value, n); main.gain.linearRampToValueAtTime(0, n + 0.025) }
  setTimeout(() => { if (deck.phase === 'rewind') audio.pause() }, 30)
  rw.from = from; rw.to = to; rw.t = 0
  rw.dur = Math.min(0.95, Math.max(0.5, 0.45 + jump * 1.4))
  deck.phase = 'rewind'
  sfx?.stop()
  sfx = playBackspin(from, rw.dur)
}

/**
 * Backspin sound: the music just behind the needle, reversed, through the same push-then-slow rate curve as the
 * platter (so pitch starts high and glides down as it stops), lightly band-limited, with a very faint
 * friction layer. Level sits a little under the music so it reads as part of the record, not an effect on top.
 */
function playBackspin(from: number, dur: number) {
  if (!actx || !pcm) return null
  const { mono, fs } = pcm
  const now = actx.currentTime
  const N = 48
  const rate = new Float32Array(N).map((_, i) => Math.max(0.06, SPIN_PEAK * spinShape((i + 0.5) / N)))
  const need = SPIN_PEAK * dur / 2.6 + 0.15 // seconds of source audio the curve consumes (≈ ∫rate dt)
  const s1 = Math.min(mono.length, Math.floor(from * fs)), s0 = Math.max(0, s1 - Math.floor(need * fs))
  if (s1 - s0 < fs * 0.1) return null
  const buf = actx.createBuffer(1, s1 - s0, fs)
  const ch = buf.getChannelData(0)
  for (let i = 0; i < ch.length; i++) ch[i] = mono[s1 - 1 - i]
  const src = actx.createBufferSource(); src.buffer = buf
  src.playbackRate.setValueCurveAtTime(rate, now, dur)
  const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90
  const tone = actx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 6500
  const g = actx.createGain()
  g.gain.setValueAtTime(0, now)
  g.gain.linearRampToValueAtTime(0.75 * audio.volume, now + 0.012)
  g.gain.setTargetAtTime(0, now + dur * 0.55, dur * 0.18)
  src.connect(hp); hp.connect(tone); tone.connect(g); g.connect(actx.destination)
  // friction: band-passed noise whose level and centre follow the spin
  const nb = actx.createBuffer(1, Math.ceil(fs * dur), fs), nd = nb.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
  const noise = actx.createBufferSource(); noise.buffer = nb
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.2
  bp.frequency.setValueCurveAtTime(rate.map(r => 1400 + r * 900), now, dur)
  const ng = actx.createGain()
  ng.gain.setValueCurveAtTime(rate.map(r => 0.012 * audio.volume * (r / SPIN_PEAK)), now, dur)
  noise.connect(bp); bp.connect(ng); ng.connect(actx.destination)
  src.start(now); noise.start(now)
  src.stop(now + dur + 0.05); noise.stop(now + dur + 0.05)
  return { stop: () => { try { src.stop(); noise.stop() } catch { /* already stopped */ } } }
}

function updateDeck(dt: number) {
  const g = posR(audio.currentTime)
  let liftTarget = 1, rTarget = deck.armR
  switch (deck.phase) {
    case 'rest': rTarget = REST_R; break
    case 'return':
      rTarget = REST_R
      if (deck.lift > 0.85 && Math.abs(deck.armR - REST_R) < 0.002) deck.phase = 'rest'
      break
    case 'hold': rTarget = g; break
    case 'cue':
      rTarget = g
      if (deck.lift > 0.7 && Math.abs(deck.armR - g) < 0.004) deck.phase = 'lower'
      break
    case 'lower':
      rTarget = g; liftTarget = 0
      if (deck.lift < 0.03) {
        deck.phase = 'play'
        if (main && actx) { const n = actx.currentTime; main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(1, n) }
        if (deck.want) audio.play().catch(() => { deck.want = false; deck.phase = 'hold'; syncState() })
      }
      break
    case 'play': rTarget = g; liftTarget = 0; break
    case 'brake': {
      liftTarget = 0
      brk.t += dt
      const k = Math.min(1, brk.t / BRAKE)
      audio.playbackRate = Math.max(0.07, brakeRate(k))
      if (main) main.gain.value = 1 - Math.max(0, (k - 0.55) / 0.45) ** 2
      deck.armR = g
      if (k >= 1) {
        audio.pause()
        audio.playbackRate = 1
        deck.phase = 'hold'
      }
      break
    }
    case 'rewind': {
      liftTarget = 0
      rw.t += dt
      const k = Math.min(1, rw.t / rw.dur)
      // needle rides outward along the groove, travelling with the spin (fast at first, settling at the end)
      deck.armR = posR(rw.from) + (posR(rw.to) - posR(rw.from)) * spinTravel(k)
      if (k >= 1) {
        deck.phase = 'play'; sfx = null
        audio.currentTime = rw.to
        if (deck.want) {
          // music comes back in over ~120 ms instead of slamming in
          if (main && actx) { const n = actx.currentTime; main.gain.cancelScheduledValues(n); main.gain.setValueAtTime(0, n); main.gain.linearRampToValueAtTime(1, n + 0.12) }
          audio.play().catch(() => { deck.want = false; deck.phase = 'hold'; syncState() })
        }
      }
      break
    }
  }
  // while playing the needle follows the groove through a short glide (~90 ms), so jumps never snap
  if (deck.phase === 'play') deck.armR += (g - deck.armR) * (1 - Math.exp(-dt / 0.09))
  else if (deck.lift > 0.8) {
    // the arm only swings once it's clear of the record: ease-out with a minimum speed
    const d = rTarget - deck.armR
    const step = Math.max(Math.abs(d) * (1 - Math.exp(-dt * 7)), 0.25 * dt)
    deck.armR += Math.sign(d) * Math.min(Math.abs(d), step)
  }
  // platter: one source of truth for the record's speed. Backspin and brake drive it directly; otherwise a motor
  // model (quick catch-up, fast settle when off). While it's still winding up, the music's speed follows it,
  // so a resume sounds like a real deck coming up to speed instead of starting at full pitch.
  if (deck.phase === 'rewind') deck.plat = -PLATTER * 7 * spinShape(rw.t / rw.dur)
  else if (deck.phase === 'brake') deck.plat = PLATTER * brakeRate(brk.t / BRAKE)
  else {
    const on = deck.want || !audio.paused, tgt = on ? PLATTER : 0
    const r = on ? 6 : 3 // strong motor: up to speed in ~0.7 s
    deck.plat += (tgt - deck.plat) * (1 - Math.exp(-dt * r))
  }
  if (deck.phase === 'play' && !audio.paused) {
    const want = deck.plat >= PLATTER * 0.97 ? 1 : Math.max(0.5, deck.plat / PLATTER)
    if (Math.abs(audio.playbackRate - want) > 0.004) { audio.preservesPitch = false; audio.playbackRate = want }
  }

  // lift spring: firm going up, a touch of bounce when the needle lands
  // quicker lift and drop (cueing a new track ≈ 0.6 s), still with a soft landing
  const k = liftTarget ? 130 : 150, damp = liftTarget ? 21 : 14
  deck.liftV += (k * (liftTarget - deck.lift) - damp * deck.liftV) * dt
  deck.lift = Math.max(-0.05, Math.min(1.05, deck.lift + deck.liftV * dt))
}

let started = false
let bassAvg = 0
export function startLoop() {
  if (started) return
  started = true
  let last = performance.now()
  const frame = (now: number) => {
    requestAnimationFrame(frame)
    lastFrameAt = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    updateDeck(dt)
    const c = clock
    c.dt = dt
    c.t = audio.currentTime
    c.duration = audio.duration || 1
    c.progress = Math.min(1, c.t / c.duration)
    c.ended = audio.ended
    c.playing = !audio.paused && !audio.ended
    c.motor = deck.want || c.playing
    c.armR = deck.armR
    c.lift = deck.lift
    c.tracking = deck.phase === 'play' || deck.phase === 'rewind'
    // platter: backwards at up to ~7× normal speed while the backspin runs
    c.spin = deck.plat
    c.latency = actx ? (actx.baseLatency || 0) + (actx.outputLatency || 0) : 0

    let bassRaw = 0, levelRaw = 0
    if (analyser && fdata && c.playing && bands.length) {
      analyser.getFloatFrequencyData(fdata)
      // show the music, not the volume knob: undo the element volume in dB
      const comp = audio.volume > 0.01 ? -20 * Math.log10(audio.volume) : 0
      let nb = 0
      for (let i = 0; i < TICKS; i++) {
        const { lo, hi, tilt } = bands[i]
        let pw = 0
        for (let k = lo; k <= hi; k++) pw += Math.pow(10, fdata[k] / 10)
        const db = 10 * Math.log10(pw / (hi - lo + 1) + 1e-12) + comp + tilt
        // a curve so the ring rests low and only strong bands reach out
        const v = Math.pow(Math.min(1, Math.max(0, (db + 66) / 58)), 1.7)
        // fast attack, smooth release
        c.spec[i] += (v - c.spec[i]) * (v > c.spec[i] ? 0.55 : 1 - Math.exp(-dt * 7))
        levelRaw += v
        if (i < 12) { bassRaw += v; nb++ }
      }
      levelRaw /= TICKS; bassRaw /= Math.max(1, nb)
    } else {
      for (let i = 0; i < TICKS; i++) c.spec[i] *= Math.exp(-dt * 5)
    }
    c.bass += (bassRaw - c.bass) * 0.35
    c.level += (levelRaw - c.level) * 0.25
    if (c.bass > bassAvg * 1.22 + 0.04 && c.beat < 0.35) c.beat = 1
    bassAvg += (c.bass - bassAvg) * 0.04
    c.beat *= Math.exp(-dt * 7)

    cbs.forEach(cb => cb(c))
  }
  requestAnimationFrame(frame)
}

// dev-only handle for inspecting the deck from the console
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__deck = { clock, audio, grooveR, deck, seek, pause }
