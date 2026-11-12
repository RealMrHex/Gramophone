<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TICKS, clock, onFrame, seek, audio } from '../composables/player'
import { layout } from '../composables/layout'
import { tier } from '../composables/settings'
import { active, analysis, fx, vinylTex } from '../composables/store'
import { buildSheen, buildVinyl } from '../render/vinyl'
import { buildArm, buildPivot, type ArmSprite } from '../render/tonearm'

const cv = ref<HTMLCanvasElement>()
let ctx: CanvasRenderingContext2D
let vinyl: HTMLCanvasElement | null = null
let sheen: HTMLCanvasElement | null = null
let arm: ArmSprite | null = null
let pivot: ReturnType<typeof buildPivot> | null = null
let armFor = 0

const TAU = Math.PI * 2
// ring starts just past the pivot housing (pivot sits at ≈ -1.03 rad, ±0.13) so it never runs under the arm
const A0 = -0.86, A1 = 1.1
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

// arm pivot in record-radius units, relative to the record centre (measured off the reference)
const PIV = { x: 0.61, y: -1.01 }

const MBLUR = [[-2, 0.18], [-1, 0.3], [1, 0.3], [2, 0.18]] as const
const MBLUR_LITE = [[-1, 0.34], [1, 0.34]] as const
let frameNo = 0, skipped = 0
const st = { angle: 0, speed: 0, kick: 0, flash: 0, time: 0, punchTo: 0, energy: 0, glow: 0, hook: 0, hookTo: 0, light: 0, cam: 0, camV: 0, camTo: 0, lastCam: -99, vig: 0, vigTo: 0 }
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__stage = st

let defaultVinyl: HTMLCanvasElement | null = null
/** record swap: the old record fades out (easing up slightly) while the new one settles in */
const swap = { prev: null as HTMLCanvasElement | null, t: 1 }
function setRecord(tex: HTMLCanvasElement | null) {
  const next = tex ?? (defaultVinyl ??= buildVinyl('Gramophone', 0, 1024, null))
  if (next === vinyl) return
  swap.prev = vinyl; swap.t = vinyl ? 0 : 1
  vinyl = next
}
function rebuildArm() {
  const k = layout.R * layout.DPR
  if (Math.abs(k - armFor) < 1 && arm) return
  armFor = k
  arm = buildArm(k)
  pivot = buildPivot(k)
}
function resize() {
  const c = cv.value!
  c.width = layout.W * layout.DPR; c.height = layout.stageH * layout.DPR
  c.style.height = layout.stageH + 'px'
  rebuildArm()
  recShadow = null; armShadows = null
}

// ── pre-blurred shadows ──
// Live canvas shadows (shadowBlur) re-blur every frame and are the most expensive thing on a phone GPU. The record's
// shadow never changes and the arm's only changes with lift, so both are blurred once into sprites.
let recShadow: { img: HTMLCanvasElement; pad: number } | null = null
function buildRecordShadow() {
  const { R, DPR } = layout
  const pad = Math.ceil(R * 0.2)
  const c = document.createElement('canvas')
  c.width = c.height = Math.ceil((R * 2 + pad * 2) * DPR)
  const g = c.getContext('2d')!
  g.scale(DPR, DPR)
  g.shadowColor = 'rgba(0,0,0,.75)'; g.shadowBlur = R * 0.08 * DPR; g.shadowOffsetY = R * 0.015 * DPR
  g.fillStyle = '#060607'; g.beginPath(); g.arc(pad + R, pad + R, R * 0.995, 0, TAU); g.fill()
  recShadow = { img: c, pad }
}
/** arm silhouette blurred for lift 0 and lift 1 (crossfaded in between); null when canvas filters aren't supported */
let armShadows: { img: HTMLCanvasElement; pad: number }[] | null = null
const canFilter = typeof document !== 'undefined' && 'filter' in (document.createElement('canvas').getContext('2d') ?? {})
function buildArmShadows() {
  if (!arm || !canFilter) return
  const { R, DPR } = layout
  armShadows = [0, 1].map(lift => {
    const blur = (10 + lift * 26) * (R / 480) / 2   // shadowBlur ≈ 2σ, in device pixels
    const pad = Math.ceil(blur * 3)
    const c = document.createElement('canvas')
    c.width = arm!.canvas.width + pad * 2; c.height = arm!.canvas.height + pad * 2
    const g = c.getContext('2d')!
    g.filter = `blur(${blur.toFixed(1)}px) brightness(0)`
    g.drawImage(arm!.canvas, pad, pad)
    return { img: c, pad: pad / DPR }
  })
}

watch(vinylTex, setRecord)

// lighting push when a new line starts: big on hooks, medium on any section change, a nudge otherwise
watch(() => active.line, (li, prev) => {
  const L = analysis.value?.lines
  if (!L || !clock.motor || li === prev) return
  const lab = L[li]?.label ?? '', prevLab = L[prev]?.label ?? ''
  const hit = lab === 'hook' ? 1 : lab !== prevLab ? 0.55 : 0
  st.punchTo = Math.max(st.punchTo, hit)
  // the "real hook" moment: entering a hook from something else — camera punch + full blood glow, at most every 3 s
  const hookStart = lab === 'hook' && prevLab !== 'hook'
  if (hookStart && st.time - st.lastCam > 3) { st.camTo = 2.2; st.lastCam = st.time; st.vigTo = 1 }
  else if (lab !== prevLab) st.vigTo = Math.max(st.vigTo, 0.45)
})
watch(() => [layout.W, layout.H, layout.R, layout.DPR, layout.stageH], resize)

let off: (() => void) | null = null
onMounted(() => {
  ctx = cv.value!.getContext('2d')!
  sheen = buildSheen()
  setRecord(vinylTex.value); resize()
  off = onFrame(draw)
})
onBeforeUnmount(() => off?.())

function deltaFor(r: number, Pd: number, Le: number) {
  return Math.acos(clamp((Pd * Pd + Le * Le - r * r) / (2 * Pd * Le), -1, 1))
}

/**
 * Warm halo behind the record, matched to the reference: a large peach-orange glow (out to ~1.3R) that swells
 * while the music is busy (dense booms, hook starts) and falls back to near-dark in sparse passages.
 * `st.glow` is the smoothed envelope (fast-ish attack, slow release), so it reads as a lighting swell, not a strobe.
 */
function drawGlow(c: typeof clock) {
  const { R, cx, cy } = layout
  const gl = st.light, on = c.motor ? 1 : 0.5
  // faded, desaturated peach haze — the motion lives in the tick ring, this just warms the stage
  const a = Math.min(0.09, (0.015 + gl * 0.075) * on)
  const outer = R * (1.28 + gl * 0.06)
  const halo = ctx.createRadialGradient(cx, cy, R * 0.95, cx, cy, outer)
  halo.addColorStop(0, `rgba(235,170,145,${a})`)
  halo.addColorStop(0.35, `rgba(220,150,128,${a * 0.55})`)
  halo.addColorStop(0.7, `rgba(205,135,115,${a * 0.18})`)
  halo.addColorStop(1, 'rgba(200,130,110,0)')
  // fill only the glow's own square (not 9× the screen)
  ctx.fillStyle = halo; ctx.fillRect(cx - outer, cy - outer, outer * 2, outer * 2)

  // hit glow: a faint warm-red light behind the record. Its *intensity* barely changes — it quickly reaches a
  // fixed, faded level — while its *size* follows the camera punch, so on a hook the light spreads out.
  const v = st.vig, k = Math.max(0, st.cam)
  if (v > 0.01) {
    const presence = Math.min(1, v * 2.2)
    const ha = 0.1 * presence
    const vo = R * (1.22 + k * 0.62)
    const blood = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, vo)
    blood.addColorStop(0, `rgba(200,58,44,${ha})`)
    blood.addColorStop(0.45, `rgba(190,52,40,${ha * 0.5})`)
    blood.addColorStop(0.75, `rgba(170,44,34,${ha * 0.16})`)
    blood.addColorStop(1, 'rgba(150,36,28,0)')
    ctx.fillStyle = blood; ctx.fillRect(cx - vo, cy - vo, vo * 2, vo * 2)
  }
}

function draw(c: typeof clock) {
  if (!ctx || !arm || !pivot) return
  const { W, R, cx, cy, DPR } = layout
  // phones: the open player sheet hides the deck — don't spend the GPU on it
  if (layout.covered) return
  // battery saver: draw every other frame (30 fps); time keeps flowing so the spin stays right
  const saver = tier.value === 'saver'
  if (saver && (frameNo++ & 1)) { skipped += c.dt; return }
  const dt = c.dt + skipped
  skipped = 0
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.clearRect(0, 0, W, layout.stageH)
  // hook punch: scale the whole gramophone (glow, record, ring, arm) about the record's centre, which sits on the
  // left edge — so it grows toward the right, from where it is. Texts don't move.
  const sc = 1 + Math.max(0, fx.kick) * 0.008
  ctx.setTransform(DPR * sc, 0, 0, DPR * sc, DPR * cx * (1 - sc), DPR * cy * (1 - sc))
  // phones: the deck is turned a quarter so the record hangs from the top (see layout.rot)
  if (layout.rot) { ctx.translate(cx, cy); ctx.rotate(layout.rot); ctx.translate(-cx, -cy) }

  st.time += dt
  // boom envelope: instant attack on the offline-detected hit, ~160 ms exponential release.
  // Without a boom map (still analysing) fall back to the realtime kick estimate.
  const hasMap = !!analysis.value?.booms.length
  const hit = hasMap ? fx.flash : (c.playing ? c.beat * 0.6 : 0)
  fx.flash = 0
  // soft, short swell rather than a strobe: eased attack toward the hit, ~250 ms release
  st.flash = Math.max(st.flash * Math.exp(-dt / 0.25), st.flash + (hit * hit * 0.8 - st.flash) * Math.min(1, dt * 30))
  // glow envelope: booms and hook/section starts pump an energy store that drains over ~0.7 s; the visible glow
  // follows it with a quick rise and a slow fall. Before the boom map exists, loudness stands in.
  st.energy = Math.min(1, st.energy * Math.exp(-dt / 0.7) + hit * 0.55)
  const want = Math.max(st.energy, hasMap ? 0 : c.level * 1.3 - 0.1)
  st.glow += (want - st.glow) * Math.min(1, dt * (want > st.glow ? 9 : 2.2))
  // hook / section accent: its own envelope on top of the (capped) boom level, so a hook always stands out
  // even in tracks where every note counts as a hit. ~90 ms rise, ~1 s fall.
  // FPS-style hit: instant attack, fast fall. Camera kick (~0.28 s) and the edge vignette (~0.55 s) fire together
  // on hook / section starts, and on big booms at a fraction of the strength.
  // camera punch: a decaying impulse drives a critically-ish damped spring → eased ~0.25 s rise, ~0.75 s settle
  st.camTo *= Math.exp(-dt / 0.18)
  st.camV += (80 * (st.camTo - st.cam) - 12 * st.camV) * dt
  st.cam += st.camV * dt
  fx.kick = Math.max(0, st.cam)
  // blood glow behind the record: quick swell, slow fade; big booms only tint it a little
  if (st.vigTo > st.vig) { st.vig += (st.vigTo - st.vig) * Math.min(1, dt * 16); if (st.vigTo - st.vig < 0.02) st.vigTo = 0 }
  else st.vig = Math.max(st.vig * Math.exp(-dt / 0.6), hit > 0.75 ? hit * 0.22 : 0)
  fx.vig = st.vig
  if (st.punchTo > 0) { st.hookTo = Math.max(st.hookTo, st.punchTo); st.punchTo = 0 }
  if (st.hookTo > st.hook) { st.hook += (st.hookTo - st.hook) * Math.min(1, dt * 11); if (st.hookTo - st.hook < 0.02) st.hookTo = 0 }
  else st.hook *= Math.exp(-dt / 1.0)
  st.light = Math.min(1, st.glow * 0.45 + st.hook * 0.85)
  drawGlow(c)

  // platter inertia: slow spin-up, longer coast-down. Visual speed is deliberately calmer than a literal
  // 33⅓ rpm (3.49 rad/s), which reads as frantic on screen; ~11 rpm matches the reference.
  const SPIN = 1.15
  const target = c.motor ? SPIN : 0
  if (c.spin !== null) st.speed = c.spin // backspin: driven directly by the deck
  // motor: catches quickly while below speed (after a backspin or on start); with the motor off it settles fast
  // (pausing already braked it in sync with the sound)
  else st.speed += (target - st.speed) * (1 - Math.exp(-dt * (c.motor ? (st.speed < target * 0.9 ? 4.5 : 1.3) : 3)))
  st.angle += st.speed * dt

  // soft drop shadow under the record (no platter rim) — a pre-blurred sprite
  if (!recShadow) buildRecordShadow()
  const rs = recShadow!
  ctx.drawImage(rs.img, cx - R - rs.pad, cy - R - rs.pad, (R + rs.pad) * 2, (R + rs.pad) * 2)
  // outgoing record during a swap
  swap.t = Math.min(1, swap.t + dt / 0.75)
  const se = swap.t * swap.t * (3 - 2 * swap.t)
  if (swap.prev && swap.t < 1) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(st.angle); ctx.scale(1 + 0.03 * se, 1 + 0.03 * se); ctx.globalAlpha = 1 - se
    ctx.drawImage(swap.prev, -R, -R, R * 2, R * 2); ctx.restore()
  } else swap.prev = null
  const inA = swap.prev ? se : 1, inS = swap.prev ? 0.97 + 0.03 * se : 1
  if (vinyl) {
    const blur = Math.min(0.05, Math.abs(st.speed) * 0.022)
    if (blur > 0.002) {
      // rotational motion blur: ghost passes trailing the sharp one
      // (phones: two ghost passes instead of four)
      for (const [o, al] of saver ? [] : layout.mobile || tier.value === 'balanced' ? MBLUR_LITE : MBLUR) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(st.angle + o * blur * 0.5); ctx.scale(inS, inS); ctx.globalAlpha = al * inA
        ctx.drawImage(vinyl, -R, -R, R * 2, R * 2); ctx.restore()
      }
    }
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(st.angle); ctx.scale(inS, inS); ctx.globalAlpha = inA
    ctx.drawImage(vinyl, -R, -R, R * 2, R * 2)
    ctx.restore()
  }
  if (sheen && !saver) {
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = Math.min(1, 0.8 + c.level * 0.2 + st.flash * 0.12)
    ctx.drawImage(sheen, cx - R, cy - R, R * 2, R * 2)
    ctx.restore()
  }

  // tick ring = live spectrum analyser: 72 log-spaced bands (40 Hz at the top of the arc → 16 kHz at the bottom).
  // Each tick's length and brightness follow its band level, in a single accent hue.
  // The hook / section light adds a gentle swell to the middle of the arc on top.
  const N = TICKS, prog = dragging ? ringFrac : c.progress, gl = st.light
  ctx.lineCap = 'round'
  for (let i = 0; i < N; i++) {
    const a = A0 + ((A1 - A0) * i) / (N - 1), cs = Math.cos(a), sn = Math.sin(a)
    const r0 = R * 1.04, big = i % 6 === 0
    const v = c.spec[i], bell = Math.exp(-Math.pow(a / 0.9, 2))
    const l = R * ((big ? 0.026 : 0.018) + v * 0.055 + gl * 0.016 * bell)
    const played = i / (N - 1) <= prog
    // one hue (the UI's warm coral accent); only brightness follows the band level
    const alpha = Math.min(0.85, (played ? 0.28 : 0.14) + v * 0.5 + gl * 0.1 * bell)
    ctx.strokeStyle = played ? `rgba(255,150,122,${alpha})` : `rgba(236,160,142,${alpha})`
    ctx.lineWidth = big ? 1.8 : 1.4
    ctx.beginPath(); ctx.moveTo(cx + cs * r0, cy + sn * r0); ctx.lineTo(cx + cs * (r0 + l), cy + sn * (r0 + l)); ctx.stroke()
  }
  ctx.lineCap = 'butt'
  const ap = A0 + (A1 - A0) * prog, ar = R * 1.027
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(170,170,180,.3)'
  ctx.beginPath(); ctx.arc(cx, cy, ar, A0, A1); ctx.stroke()
  ctx.strokeStyle = 'rgba(255,122,89,.85)'
  ctx.beginPath(); ctx.arc(cx, cy, ar, A0, ap); ctx.stroke()
  const mx = cx + Math.cos(ap) * ar, my = cy + Math.sin(ap) * ar
  const pulse = 1 + st.flash * 0.25
  ctx.fillStyle = 'rgba(255,122,89,.18)'; ctx.beginPath(); ctx.arc(mx, my, 11 * pulse, 0, TAU); ctx.fill()
  ctx.fillStyle = '#050506'; ctx.strokeStyle = '#ff7a59'; ctx.lineWidth = 1.6
  ctx.beginPath(); ctx.arc(mx, my, 6.5, 0, TAU); ctx.fill(); ctx.stroke()
  ctx.fillStyle = '#ff7a59'; ctx.beginPath(); ctx.arc(mx, my, 2.4, 0, TAU); ctx.fill()

  // ---- tonearm: stylus rides a true arc about the pivot ----
  const Le = Math.hypot(arm.tipX, arm.tipY), alpha = Math.atan2(arm.tipY, arm.tipX)
  const Pd = Math.hypot(PIV.x, PIV.y), phi0 = Math.atan2(-PIV.y, -PIV.x)
  // radius + lift come straight from the deck (player.ts), which also gates playback on the needle drop,
  // so the stylus is exactly on the groove for the audio position whenever sound is playing.
  const lift = Math.max(0, c.lift)
  st.kick += ((c.tracking ? st.flash : 0) - st.kick) * 0.5
  const jitter = c.tracking ? (Math.sin(st.angle) * 0.0006 + st.kick * 0.0012 + (Math.random() - 0.5) * 0.0004 * (0.3 + c.level * 3)) : 0
  const delta = deltaFor(c.armR, Pd, Le) + jitter
  const phi = phi0 - delta, theta = phi - alpha
  const px = cx + PIV.x * R, py = cy + PIV.y * R

  // soft contact shadow on the record
  const tipx = px + Math.cos(phi) * Le * R, tipy = py + Math.sin(phi) * Le * R
  if (c.tracking && lift < 0.5) {
    const cg = ctx.createRadialGradient(tipx, tipy, 0, tipx, tipy, R * 0.07)
    cg.addColorStop(0, `rgba(255,150,80,${0.35 * (1 - lift * 2) * (0.5 + c.level)})`); cg.addColorStop(1, 'rgba(255,120,60,0)')
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(tipx, tipy, R * 0.07, 0, TAU); ctx.fill()
  }

  const half = pivot.half * R
  ctx.drawImage(pivot.base, px - half, py - half, half * 2, half * 2)
  const aw = arm.canvas.width / DPR, ah = arm.canvas.height / DPR
  if (!armShadows && canFilter) buildArmShadows()
  if (armShadows) {
    // shadow falls down-right on screen whatever the deck rotation; offsets are in device px like shadowOffset
    let ox = (5 + lift * 16) * (R / 480) / DPR, oy = (9 + lift * 28) * (R / 480) / DPR
    if (layout.rot) { const c0 = Math.cos(-layout.rot), s0 = Math.sin(-layout.rot); [ox, oy] = [ox * c0 - oy * s0, ox * s0 + oy * c0] }
    const a = 0.62 - lift * 0.18
    for (const [k, w] of [[0, 1 - lift], [1, lift]] as const) {
      if (w < 0.02) continue
      const sh = armShadows[k]
      ctx.save(); ctx.globalAlpha = a * w
      ctx.translate(px + ox, py + oy); ctx.rotate(theta)
      ctx.drawImage(sh.img, -arm.ox / DPR - sh.pad, -arm.oy / DPR - sh.pad, aw + sh.pad * 2, ah + sh.pad * 2)
      ctx.restore()
    }
  }
  ctx.save()
  if (!armShadows) {
    ctx.shadowColor = `rgba(0,0,0,${0.62 - lift * 0.18})`
    ctx.shadowBlur = (10 + lift * 26) * (R / 480)
    ctx.shadowOffsetX = (5 + lift * 16) * (R / 480)
    ctx.shadowOffsetY = (9 + lift * 28) * (R / 480)
  }
  ctx.translate(px, py); ctx.rotate(theta)
  ctx.drawImage(arm.canvas, -arm.ox / DPR, -arm.oy / DPR, aw, ah)
  ctx.restore()
  ctx.drawImage(pivot.cap, px - half, py - half, half * 2, half * 2)
}

// ---- scrubbing on the tick ring ----
let dragging = false, ringFrac = 0
function ringAngle(e: PointerEvent) {
  const dx = e.clientX - layout.cx, dy = e.clientY - layout.cy
  // back into the deck's own (unrotated) frame, wrapped to (-π, π]
  let a = Math.atan2(dy, dx) - layout.rot
  if (a <= -Math.PI) a += TAU; else if (a > Math.PI) a -= TAU
  return { r: Math.hypot(dx, dy), a }
}
function onDown(e: PointerEvent) {
  const { r, a } = ringAngle(e)
  if (r > layout.R * 1.02 && r < layout.R * 1.4 && a >= A0 - 0.06 && a <= A1 + 0.06) { dragging = true; scrub(e); cv.value!.setPointerCapture(e.pointerId) }
}
// drag previews the marker; the jump happens once, on release
function scrub(e: PointerEvent) {
  const { a } = ringAngle(e)
  ringFrac = clamp((a - A0) / (A1 - A0), 0, 1)
}
function onMove(e: PointerEvent) {
  if (dragging) scrub(e)
  else {
    const { r, a } = ringAngle(e)
    cv.value!.style.cursor = r > layout.R * 1.02 && r < layout.R * 1.4 && a >= A0 && a <= A1 ? 'pointer' : 'default'
  }
}
const onUp = () => { if (!dragging) return; dragging = false; seek(ringFrac * (audio.duration || 0), { smooth: true }) }
</script>

<template>
  <canvas ref="cv" class="stage" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" />
</template>

<style scoped>
.stage { position: fixed; left: 0; top: 0; width: 100%; height: 100%; touch-action: none; }
</style>
