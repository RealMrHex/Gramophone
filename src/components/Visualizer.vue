<script setup lang="ts">
/**
 * What fills the melody area when analysis is turned off (Settings): the song's title and artist, big, over a live
 * spectrum — soft rounded bars in the app's coral, mirrored into a faint reflection. It reads the analyser data the
 * player already computes every frame, so it costs almost nothing.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { layout } from '../composables/layout'
import { onFrame } from '../composables/player'
import { current } from '../composables/library'

const cv = ref<HTMLCanvasElement>()
const box = computed(() => {
  const left = layout.mobile ? 24 : layout.lanesLeft, right = layout.mobile ? 24 : layout.lanesRight
  const top = layout.mobile ? layout.lanesTop : 0, bottom = layout.mobile ? layout.lanesBottom : 0
  return { left, right, top, bottom }
})
const BARS = 40
const lv = new Float32Array(BARS)

let off: (() => void) | null = null
onMounted(() => {
  off = onFrame(c => {
    const el = cv.value
    if (!el || layout.covered) return
    const dpr = Math.min(2, devicePixelRatio || 1)
    const w = el.clientWidth, h = el.clientHeight
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr) }
    const g = el.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    // 72 analyser bands → 40 bars (skip the very top, it's mostly air)
    for (let i = 0; i < BARS; i++) {
      const v = c.spec[Math.min(c.spec.length - 1, Math.floor((i / BARS) * c.spec.length * 0.9))] || 0
      lv[i] += (v - lv[i]) * (v > lv[i] ? 0.5 : 0.12)
    }
    const base = h * 0.66, gap = w / BARS, bw = Math.max(3, gap * 0.46)
    for (let i = 0; i < BARS; i++) {
      const x = i * gap + (gap - bw) / 2
      const bh = Math.max(bw, lv[i] * base * 0.95)
      const a = 0.35 + lv[i] * 0.6
      const grd = g.createLinearGradient(0, base - bh, 0, base)
      grd.addColorStop(0, `rgba(255,190,165,${a})`); grd.addColorStop(1, `rgba(255,122,89,${a * 0.85})`)
      g.fillStyle = grd
      g.beginPath(); g.roundRect(x, base - bh, bw, bh, bw / 2); g.fill()
      // reflection
      g.fillStyle = `rgba(255,122,89,${a * 0.12})`
      g.beginPath(); g.roundRect(x, base + 6, bw, bh * 0.35, bw / 2); g.fill()
    }
  })
})
onBeforeUnmount(() => off?.())
</script>

<template>
  <div class="viz" :class="{ mobile: layout.mobile }" :style="{ left: box.left + 'px', right: box.right + 'px', top: box.top + 'px', bottom: box.bottom + 'px' }">
    <div class="titles">
      <h2>{{ current?.title }}</h2>
      <p>{{ current?.artist || 'Unknown artist' }}</p>
    </div>
    <canvas ref="cv" />
  </div>
</template>

<style scoped>
.viz { position: fixed; z-index: 3; display: flex; flex-direction: column; justify-content: center; gap: 22px; pointer-events: none; padding: 0 8px; }
.titles { text-align: left; }
.viz.mobile .titles { text-align: center; }
h2 { margin: 0; font-size: clamp(22px, 3.2vw, 40px); font-weight: 650; letter-spacing: -.02em; color: #f4eef0; line-height: 1.15;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
p { margin: 6px 0 0; font-size: clamp(14px, 1.4vw, 18px); color: #a39ba0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
canvas { width: 100%; height: clamp(110px, 22vh, 220px); display: block; }
.viz.mobile h2 { font-size: 27px; }
</style>
