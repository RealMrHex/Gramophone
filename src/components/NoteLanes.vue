<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { analysis, active, fx } from '../composables/store'
import { layout } from '../composables/layout'
import { tier } from '../composables/settings'
import { onFrame, play, seek } from '../composables/player'
import type { Token } from '../types'

const root = ref<HTMLElement>()
/** bumps on every new analysis, so a new track's rows mount fresh and fade in instead of blinking */
const seq = ref(0)
watch(analysis, () => { seq.value++ })
/** room left of the lines for the section labels (the lanes box is clipped) */
const GUTTER = 90
const lines = computed(() => analysis.value?.lines ?? [])
const visible = computed(() => {
  const out: number[] = []
  // battery saver keeps fewer lines on screen
  const back = tier.value === 'saver' ? 2 : 4, ahead = tier.value === 'saver' ? 3 : 5
  for (let i = Math.max(0, active.line - back); i <= Math.min(lines.value.length - 1, active.line + ahead); i++) out.push(i)
  return out
})

/** Each pitch class has its own colour, so the same note always lights up the same way. */
const PC = [
  '255,93,93', '255,138,61', '246,196,69', '217,106,214', '94,227,139', '61,214,208',
  '56,182,255', '122,123,255', '160,123,255', '192,132,252', '244,114,182', '251,113,133',
]
const REST = '99,102,241'
const colorOf = (t: Pick<Token, 'midi' | 'rest'>) => (t.rest || t.midi == null ? REST : PC[((t.midi % 12) + 12) % 12])

function rowStyle(li: number) {
  const d = li - active.line, ad = Math.abs(d)
  const gap = layout.laneGap
  return {
    transform: `translateY(calc(-50% + ${d * gap}px)) translateX(${-ad * 14}px) rotate(${Math.max(-20, Math.min(20, d * 6.5))}deg) scale(${Math.max(0.7, 1 - ad * 0.035)})`,
    opacity: ad === 0 ? 1 : ad > 4 ? 0 : Math.max(0, (layout.mobile ? 0.42 : 0.62) - ad * (layout.mobile ? 0.1 : 0.14)),
    // phones: no blur filter (re-rasterising blurred text while rows glide is costly) — opacity does the fading
    filter: ad && !layout.mobile && tier.value === 'high' ? `blur(${Math.min(1 + ad * 1.1, 6)}px)` : 'none',
    zIndex: 10 - ad,
  }
}
function tokClass(gi: number, rest: boolean | undefined) {
  return {
    rest,
    past: gi < active.idx || (gi === active.idx && !active.on),
    on: gi === active.idx && active.on,
  }
}
const go = (t0: number) => { seek(t0); play() }

// ── per-frame: note fill + the hopping marker that travels to the next note ──
let hop: HTMLElement | null = null

let off: (() => void) | null = null
/** horizontal follow: long lines (phones) slide left so the note being sung stays in view */
let sx = 0, sxRow: HTMLElement | null = null, lastHk = '', lastSx = '', lastHc = '', lastOp = '', sliding = false
/** per-token geometry of the measured line(s): left / width / top / height inside the line, plus the element */
interface Geo { el: HTMLElement; row: HTMLElement; l: number; w: number; t: number; h: number }
const geo = new Map<number, Geo>()
const lineBox = { hostW: 0, rowW: 0 }
function measureLineOf(gi: number) {
  const el = root.value?.querySelector<HTMLElement>(`[data-gi="${gi}"]`)
  if (!el || !root.value) return
  const row = el.parentElement as HTMLElement
  geo.clear()
  for (const t of row.querySelectorAll<HTMLElement>('[data-gi]')) {
    geo.set(Number(t.dataset.gi), { el: t, row, l: t.offsetLeft, w: t.offsetWidth, t: t.offsetTop, h: t.offsetHeight })
  }
  lineBox.hostW = root.value.clientWidth
  lineBox.rowW = row.scrollWidth
}
// sizes change → measure again (rows re-render on a new track → their elements change too)
watch(() => [layout.W, layout.H, layout.laneFont, layout.mobile, seq.value], () => geo.clear())
onMounted(() => {
  hop = document.createElement('i'); hop.className = 'hop'
  off = onFrame(c => {
    const a = analysis.value
    const host = root.value
    if (!a || !host || !a.flat.length) return
    // phones: hidden behind the open player sheet — nothing to animate
    if (layout.covered) return
    const gi = Math.max(0, active.idx)
    const cur = a.flat[gi], nxt = a.flat[gi + 1]
    // geometry is measured once per line (and on resize), never per frame: reading offsets right after writing
    // styles would force a full layout every frame
    let g = geo.get(gi)
    if (!g) { measureLineOf(gi); g = geo.get(gi) }
    if (!cur || !g) return
    const curEl = g.el, row = g.row

    if (active.on) {
      const p = Math.min(1, Math.max(0, (c.t - cur.t0) / Math.max(0.05, cur.t1 - cur.t0)))
      const ps = p.toFixed(2)
      if (curEl.dataset.p !== ps) { curEl.dataset.p = ps; curEl.style.setProperty('--p', ps) }
    }

    // keep the current note inside the visible part of the lane (before the right fade); a new line starts at 0
    if (sxRow !== row) { sxRow?.parentElement?.classList.remove('sliding'); sx = 0; sxRow = row; lastHk = ''; lastSx = ''; sliding = false }
    // hook punch on the current line only (same spring as the gramophone). Set on that one element and only when it
    // changes — a custom property on the lanes root would restyle every row every frame.
    const hk = Math.max(0, fx.kick).toFixed(3)
    if (hk !== lastHk) { row.style.setProperty('--hk', hk); lastHk = hk }
    const gn = nxt && nxt.line === cur.line ? geo.get(gi + 1) ?? null : null
    const reach = Math.max(g.l + g.w, gn ? gn.l + gn.w : 0)
    const avail = lineBox.hostW - GUTTER - 64
    const want = Math.max(0, Math.min(lineBox.rowW - avail, reach - avail * 0.72))
    sx += (want - sx) * Math.min(1, c.dt * 5)
    const sxs = sx.toFixed(1)
    if (sxs !== lastSx) { row.style.setProperty('--sx', sxs + 'px'); lastSx = sxs }
    // once a line slides, clip it at its own start so it never runs back over the ring / record
    if ((sx > 1) !== sliding) { sliding = sx > 1; row.parentElement?.classList.toggle('sliding', sliding) }
    if (hop!.parentElement !== row) row.appendChild(hop!)
    const before = active.idx < 0
    const span = nxt ? Math.max(0.05, nxt.t0 - cur.t0) : 1
    const p = before ? 0 : Math.min(1, Math.max(0, (c.t - cur.t0) / span))
    const tg = before ? g : gn ?? g
    const fs = g.h
    const x0 = g.l + g.w / 2, x1 = tg.l + tg.w / 2
    const e = p * p * (3 - 2 * p)
    const x = x0 + (x1 - x0) * e, y = g.t - fs * 0.42 - Math.sin(Math.PI * p) * fs * 0.3
    // the marker wears the colour of the note it's leaving and blends into the next note's as it lands
    const ca = colorOf(cur).split(',').map(Number), cb = colorOf(before ? cur : gn ? nxt! : cur).split(',').map(Number)
    const mix = before ? 0 : Math.min(1, Math.max(0, (p - 0.35) / 0.55))
    const hc = ca.map((v, i) => Math.round(v + (cb[i] - v) * mix)).join(',')
    if (hc !== lastHc) { hop!.style.setProperty('--hc', hc); lastHc = hc }
    hop!.style.transform = `translate(${(x - fs * 0.15).toFixed(1)}px, ${(y - fs * 0.15).toFixed(1)}px) rotate(${(45 + p * 90).toFixed(1)}deg)`
    const op = !active.on && c.playing && !gn ? '0.35' : '1'
    if (op !== lastOp) { hop!.style.opacity = op; lastOp = op }
  })
})
onBeforeUnmount(() => { off?.(); hop?.remove() })
</script>

<template>
  <div
    ref="root" class="lanes" :class="{ mobile: layout.mobile }"
    :style="{ left: layout.lanesLeft - GUTTER + 'px', right: layout.lanesRight + 'px', top: layout.lanesTop + 'px', bottom: layout.lanesBottom + 'px', fontSize: layout.laneFont + 'px', '--gutter': GUTTER + 'px' }"
  >
    <div v-for="li in visible" :key="seq + ':' + li" class="row" :class="{ cur: li === active.line }" :style="rowStyle(li)">
      <span class="inner">
        <span class="tag">{{ lines[li].label }}</span>
        <span
          v-for="t in lines[li].tokens" :key="t.gi" class="tok" :class="tokClass(t.gi, t.rest)"
          :data-gi="t.gi" :style="{ '--c': colorOf(t) }"
          @click="!t.rest && go(t.t0)"
        >{{ t.text }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.lanes {
  /* clipped to the stage (with a soft fade before the sidebar); the left gutter keeps section labels inside */
  position: fixed; top: 0; bottom: 0; pointer-events: none; overflow: hidden;
  font-family: var(--mono); font-weight: 500;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 56px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 56px), transparent);
}
.row {
  animation: rowIn .55s ease-out both;
  position: absolute; left: var(--gutter); top: 50%; white-space: nowrap; transform-origin: 0 50%; pointer-events: auto;
  transition: transform .75s cubic-bezier(.2, .8, .2, 1), opacity .75s, filter .75s;
}
.inner { display: inline-block; position: relative; transform-origin: 0 50%; padding-left: 1.7em; }
.row.sliding {
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 1.6em);
  mask-image: linear-gradient(90deg, transparent, #000 1.6em);
}
/* the mask only paints inside the row's box: give it room above (where the hopping marker arcs) and below,
   symmetric so the line stays centred */
.row { padding: 1.7em 0; }
.row.cur .inner { transform: translateX(calc(var(--sx, 0px) * -1)) scale(calc(1 + var(--hk, 0) * 0.05)); }
/* phones: one cheap mask (right edge); the band's top/bottom rows already fade out by opacity */
.lanes.mobile {
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 36px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 36px), transparent);
}
.lanes.mobile .row { transition: transform .75s cubic-bezier(.2, .8, .2, 1), opacity .75s; }
.lanes.mobile .tag { font-size: .5em; }
.tag {
  /* sits in its own space left of the melody, right-aligned, so any section name fits without touching the notes */
  position: absolute; right: calc(100% - 1.15em); top: 50%; transform: translateY(-50%);
  font-size: .42em; letter-spacing: .05em; color: rgba(255, 122, 89, .85); white-space: nowrap;
}
.tok {
  --p: 0; --c: 99, 102, 241;
  display: inline-block; position: relative; padding: .1em .3em; margin-right: .12em; border-radius: .3em;
  color: var(--dim); cursor: pointer; background-color: transparent;
  transition: color .3s ease, background-color .45s ease;
}
.tok.rest { cursor: default; }
.tok.past { color: #e6e6e9; }
/* minimal playhead: a soft tint of the note's colour + a thin progress underline that fills while it sounds */
.tok.on { color: #fff; background-color: rgba(var(--c), .16); }
.tok::after {
  content: ""; position: absolute; left: .3em; right: .3em; bottom: .02em; height: 2px; border-radius: 1px;
  background: rgb(var(--c)); transform: scaleX(0); transform-origin: 0 50%; opacity: 0; pointer-events: none;
  transition: opacity .45s ease;
}
.tok.on::after { opacity: .9; transform: scaleX(var(--p)); transition: none; }
.tok.past::after { transform: scaleX(1); opacity: 0; }
@keyframes rowIn { from { opacity: 0; } }
</style>

<style>
/* the hopping marker lives inside whichever row is current, so it is not scoped */
.hop {
  --hc: 99, 102, 241;
  position: absolute; left: 0; top: 0; width: .3em; height: .3em; z-index: 5; pointer-events: none;
  border: 1.5px solid rgba(var(--hc), .9); background: rgba(var(--hc), .22); border-radius: 2px;
  transition: opacity .2s;
}
</style>
