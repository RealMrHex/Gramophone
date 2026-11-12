<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowUpDown, AudioLines, Check, ChevronDown, CopyX, Disc3, Ellipsis, FolderPlus, GripVertical, Link2, RotateCcw, Settings2, Smartphone, TriangleAlert, ListEnd, ListMusic, ListPlus, Music, Pause,
  Pencil, Play, Plus, Repeat, Repeat1, Search, Shuffle, SkipBack, SkipForward, Trash2, Volume1, Volume2, VolumeX, X,
} from 'lucide-vue-next'
import Popover from './Popover.vue'
import { audio, duration, fmt, onFrame, playing, seek, toggle } from '../composables/player'
import { layout } from '../composables/layout'
import { analysis } from '../composables/store'
import {
  addFiles, addToPlaylist, clearPlaylist, createPlaylist, current, cycleRepeat, deletePlaylist, hasNext, lib, moveTrack, next,
  playNext, playTrack, prev, removeDuplicates, removeFromPlaylist, renamePlaylist, retryTrack, reversePlaylist, setVol, status, toggleMute, toggleShuffle, ui,
  ensureArtwork, scanPhone, totalDuration, viewed, viewPlaylist, viewTracks, type Track,
} from '../composables/library'
import { collectPicked } from '../composables/files'
import { isDeviceUrl, isNative } from '../composables/native'
import { settings } from '../composables/settings'

/** "gb minor" → "G♭ minor" */
const keyName = computed(() => {
  const k = analysis.value?.specs?.key
  if (!k) return ''
  const [n, mode] = k.split(' ')
  return n[0].toUpperCase() + (n[1] === 'b' ? '♭' : n.slice(1)) + ' ' + mode
})
const bpm = computed(() => analysis.value?.specs?.bpm ?? null)
const fmtLong = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min` }

// ── scrubber: preview while dragging, commit on release ──
// Everything that moves with the finger (fill, knob, ghost, bubble, time readouts) is written straight to the DOM
// each frame. Only show/hide flips touch Vue, so dragging never re-renders the sidebar (and its whole queue).
const track = ref<HTMLElement>(), fill = ref<HTMLElement>(), knob = ref<HTMLElement>(), mring = ref<SVGCircleElement>()
const ghost = ref<HTMLElement>(), bubble = ref<HTMLElement>(), tNow = ref<HTMLElement>()
let dragging = false, dragFrac = 0, hoverFrac = -1
/** after release the bar holds the chosen spot until playback has actually moved there (no snap-back) */
let held = -1, heldAt = 0
const scrubDrag = ref(false), hovering = ref(false)
const fracAt = (e: PointerEvent) => { const r = track.value!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) }
function down(e: PointerEvent) {
  if (!current.value || e.button > 0) return
  e.preventDefault()
  dragging = true; scrubDrag.value = true; dragFrac = fracAt(e)
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function move(e: PointerEvent) {
  if (dragging) dragFrac = fracAt(e)
  else if (current.value && e.pointerType === 'mouse') { hoverFrac = fracAt(e); if (!hovering.value) hovering.value = true }
}
function leave() { hoverFrac = -1; if (hovering.value) hovering.value = false }
function up() {
  if (!dragging) return
  dragging = false; scrubDrag.value = false
  held = dragFrac; heldAt = performance.now()
  seek(dragFrac * (audio.duration || 0), { smooth: true })
}
/** the browser took the gesture away: drop the preview, don't seek */
function cancel() { dragging = false; scrubDrag.value = false }
let lastNow = '', lastBubble = '', lastAria = '', lastRing = ''
let off: (() => void) | null = null
onMounted(() => {
  off = onFrame(c => {
    const has = !!current.value && c.duration > 0
    const live = has ? Math.min(1, c.t / c.duration) : 0
    if (held >= 0 && (!has || Math.abs(live - held) * c.duration < 0.35 || performance.now() - heldAt > 1500)) held = -1
    const f = dragging ? dragFrac : held >= 0 ? held : live
    // ring on the mini player: only when its value visibly changes
    const ring = (100 - f * 100).toFixed(1)
    if (mring.value && ring !== lastRing) { mring.value.style.strokeDashoffset = ring; lastRing = ring }
    // phones: the big seek bar is inside the closed sheet — nothing to update (docked = always on screen)
    if (layout.mobile && !sheet.value && !docked.value) return
    // transforms only (no layout): the fill scales, the knob rides a full-width rail
    if (fill.value) fill.value.style.transform = `scaleX(${f.toFixed(4)})`
    if (knob.value) knob.value.style.transform = `translateX(${(f * 100).toFixed(2)}%)`
    // left readout follows the finger while dragging
    const now = has ? fmt(f * c.duration) : '0:00'
    if (tNow.value && now !== lastNow) { tNow.value.textContent = now; lastNow = now }
    const tip = dragging ? dragFrac : hoverFrac
    if (ghost.value) ghost.value.style.width = `${Math.max(0, hoverFrac) * 100}%`
    if (bubble.value && tip >= 0) {
      bubble.value.style.left = `${tip * 100}%`
      const txt = fmt(tip * c.duration)
      if (txt !== lastBubble) { bubble.value.textContent = txt; lastBubble = txt }
    }
    const aria = has ? `${now} of ${fmt(c.duration)}` : 'Nothing playing'
    if (track.value && aria !== lastAria) {
      track.value.setAttribute('aria-valuetext', aria); track.value.setAttribute('aria-valuenow', String(Math.round(f * c.duration))); lastAria = aria
    }
  })
})
onBeforeUnmount(() => off?.())
// ── phones: the whole sidebar is a bottom sheet; collapsed it is a mini player ──
const sheet = ref(false), sheetDy = ref(0), closeBtn = ref<HTMLElement>()
watch(() => layout.mobile, m => { if (!m) setSheet(false) })
// tell the stage when it's hidden behind the open sheet (it pauses its drawing)
watch([sheet, () => layout.mobile, sheetDy], ([o, m, dy]) => { layout.covered = !!(o && m && dy === 0) }, { immediate: true })
/** open/close; on phones an open sheet owns a history entry, so the system back gesture closes it */
function setSheet(open: boolean, fromHistory = false, viaKeyboard = false) {
  if (open === sheet.value) return
  sheet.value = open
  if (open) {
    history.pushState({ ...(history.state ?? {}), gmSheet: true }, '')
    // keyboard users land on the close button; touch users get no stray focus ring
    if (viaKeyboard) nextTick(() => closeBtn.value?.focus({ preventScroll: true }))
  } else if (!fromHistory && history.state?.gmSheet) history.back()
}
const onPop = () => { if (sheet.value) setSheet(false, true) }
const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && sheet.value) setSheet(false) }
onMounted(() => { addEventListener('popstate', onPop); addEventListener('keydown', onEsc) })
onBeforeUnmount(() => { removeEventListener('popstate', onPop); removeEventListener('keydown', onEsc) })

// drag the handle / header: follows the finger, settles by distance or by a quick flick
let gy = -1, gdy = 0, gt = 0, gv = 0
let gOnHandle = false
function gDown(e: PointerEvent) {
  if (docked.value) return
  // the handle is a button (for keyboards) but it's also the main thing people drag — only other buttons opt out
  if ((e.target as HTMLElement).closest('button:not(.handle)')) return
  gOnHandle = !!(e.target as HTMLElement).closest('.handle')
  gy = e.clientY; gdy = 0; gt = e.timeStamp; gv = 0
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function gMove(e: PointerEvent) {
  if (gy < 0) return
  const d = e.clientY - gy, dt = Math.max(1, e.timeStamp - gt)
  gv = gv * 0.6 + ((d - gdy) / dt) * 0.4; gdy = d; gt = e.timeStamp
  sheetDy.value = sheet.value ? Math.max(0, d) : Math.min(0, d)
}
function gUp() {
  if (gy < 0) return
  const d = gdy; gy = -1; sheetDy.value = 0
  // a tap opens the closed sheet; on the open sheet only ⌄ / the handle close it (taps on the header text do nothing)
  if (Math.abs(d) < 8) { if (!sheet.value || gOnHandle) setSheet(!sheet.value) }
  else if (gv < -0.45 || d < -60) setSheet(true)
  else if (gv > 0.45 || d > 60) setSheet(false)
}
/** phones, first run: no songs at all yet — the onboarding card is the whole screen, the mini player waits */
const libraryEmpty = computed(() => layout.mobile && !current.value && !Object.keys(lib.tracks).length)
/**
 * Phones with melody analysis off: there are no note lanes to show, so the player and queue sit open in the page,
 * docked right under the record — no mini player, handle or pull-up sheet.
 */
const docked = computed(() => layout.mobile && !settings.analysis && !libraryEmpty.value)
watch(docked, d => { if (d) { setSheet(false); layout.covered = false } })
const sheetStyle = computed(() => {
  if (docked.value) return { top: Math.round(layout.lanesTop - 6) + 'px', height: 'auto', transform: 'none' }
  if (!layout.mobile) return { width: layout.side + 'px' }
  const h = Math.round(Math.min(layout.H - layout.safeTop - 56, layout.H * 0.88)), closed = h - layout.peek - layout.safeBottom
  return { height: h + 'px', transform: `translateY(${(sheet.value ? 0 : closed) + sheetDy.value}px)` }
})
// open sheet: divider under the header once the body scrolls
const bodyEl = ref<HTMLElement>(), bodyScrolled = ref(false)
const onBodyScroll = () => { bodyScrolled.value = (bodyEl.value?.scrollTop ?? 0) > 4; queueRange() }
watch(sheet, o => { if (!o && bodyEl.value) bodyEl.value.scrollTop = 0 })
const playingFrom = computed(() => lib.playlists.find(p => p.id === lib.playingId)?.name ?? viewed.value?.name ?? 'Library')

// seek slider keyboard: ←/→ 5 s, shift for 15 s, Home/End
function onSeekKey(e: KeyboardEvent) {
  if (!current.value) return
  const step = e.shiftKey ? 15 : 5, t = audio.currentTime
  let to: number | null = null
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = t + step
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = t - step
  else if (e.key === 'Home') to = 0
  else if (e.key === 'End') to = (audio.duration || 0) - 1
  if (to === null) return
  e.preventDefault(); e.stopPropagation()
  seek(Math.max(0, to), { smooth: true })
}

const volPct = computed(() => (lib.muted ? 0 : lib.volume) * 100)
// custom volume slider: drag, wheel, arrow keys
const vtrack = ref<HTMLElement>(), vDrag = ref(false)
const vAt = (e: PointerEvent) => { const r = vtrack.value!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) }
function vDown(e: PointerEvent) { vDrag.value = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setVol(vAt(e)) }
function vMove(e: PointerEvent) { if (vDrag.value) setVol(vAt(e)) }
function vUp() { vDrag.value = false }
function onVolWheel(e: WheelEvent) { setVol((lib.muted ? 0 : lib.volume) - Math.sign(e.deltaY) * 0.04) }
function onVolKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 0.1 : 0.04, v = lib.muted ? 0 : lib.volume
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setVol(v + step) }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setVol(v - step) }
}

// ── adding ──
function onAdd(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length) {
    const files = collectPicked(input.files)
    if (files.length) addFiles(files); else status.message = 'No audio files found there.'
  }
  input.value = ''
  addOpen.value = false
}

// ── list: search, play, reorder ──
const searchOpen = ref(false)
const query = ref('')
const searchInput = ref<HTMLInputElement>()
async function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) { await nextTick(); searchInput.value?.focus() } else query.value = ''
}
const rows = computed(() => {
  const q = query.value.trim().toLowerCase()
  // i = position in the playlist (viewTracks follows trackIds order, skipping ids with no track)
  const ids = viewed.value?.trackIds ?? [], pos = new Map<number, number>()
  ids.forEach((id, i) => pos.set(id, i))
  const all = viewTracks.value.map(t => ({ t, i: pos.get(t.id)! }))
  return q ? all.filter(({ t }) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)) : all
})

// ── virtual list: only the rows on screen (+ a margin) are in the DOM, so 2,000 songs scroll like 20 ──
const listEl = ref<HTMLElement>()
const ROW_H = computed(() => (layout.mobile ? 64 : 56))
const OVERSCAN = 8
const range = ref({ from: 0, to: 40 })
const scroller = () => (layout.mobile ? bodyEl.value : listEl.value) ?? null
let rangeRaf = 0
function measureRange() {
  rangeRaf = 0
  const sc = scroller(), list = listEl.value
  if (!sc || !list) return
  const top = list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
  const y = sc.scrollTop - top, h = sc.clientHeight || 600, n = rows.value.length
  const from = Math.max(0, Math.floor(y / ROW_H.value) - OVERSCAN)
  const to = Math.min(n, Math.ceil((y + h) / ROW_H.value) + OVERSCAN)
  if (from !== range.value.from || to !== range.value.to) range.value = { from, to }
}
const queueRange = () => { if (!rangeRaf) rangeRaf = requestAnimationFrame(measureRange) }
const shown = computed(() => rows.value.slice(range.value.from, range.value.to))
const padTop = computed(() => range.value.from * ROW_H.value)
const padBottom = computed(() => Math.max(0, rows.value.length - range.value.to) * ROW_H.value)
watch([rows, () => layout.mobile, () => layout.H, sheet, () => settings.analysis], () => nextTick(queueRange), { immediate: true })
let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(queueRange)
  if (listEl.value) ro.observe(listEl.value)
  if (bodyEl.value) ro.observe(bodyEl.value)
})
onBeforeUnmount(() => { ro?.disconnect(); cancelAnimationFrame(rangeRaf) })
// covers for phone songs load as they come into view
watch(shown, list => { for (const { t } of list) if (!t.cover) ensureArtwork(t.id) })
const isPlayingHere = computed(() => lib.playingId === lib.viewId)
const isCur = (id: number) => id === lib.currentId && isPlayingHere.value
const pick = (id: number) => { if (!isCur(id)) playTrack(id, lib.viewId, true); else toggle() }
const unavailable = computed(() => viewTracks.value.filter(t => t.failed).length)
function openLinks() { addOpen.value = false; ui.linkDialog = true }
function scanNow() { addOpen.value = false; void scanPhone() }
let dragFrom = -1
const dropAt = ref(-1)
const canReorder = computed(() => !query.value.trim())
function onDragStart(i: number, e: DragEvent) { dragFrom = i; e.dataTransfer?.setData('text/x-gramophone-row', String(i)); e.dataTransfer!.effectAllowed = 'move' }
function onDragOver(i: number, e: DragEvent) { if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation(); dropAt.value = i }
function onDrop(i: number, e: DragEvent) { if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation(); moveTrack(lib.viewId, dragFrom, i); dragFrom = -1; dropAt.value = -1 }
function onDragEnd() { dragFrom = -1; dropAt.value = -1 }

// phones: reorder by the grip only (the rest of the row scrolls). The row follows the finger, a line marks the slot,
// and the list auto-scrolls near the edges.
const liftFrom = ref(-1), liftDy = ref(0)
let liftY0 = 0, liftScroll0 = 0, liftY = 0, liftRaf = 0
function gripDown(i: number, e: PointerEvent) {
  if (!canReorder.value || liftFrom.value >= 0) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  liftFrom.value = i; liftDy.value = 0; dropAt.value = -1
  liftY0 = liftY = e.clientY; liftScroll0 = bodyEl.value?.scrollTop ?? 0
  navigator.vibrate?.(8)
  const tick = () => {
    const b = bodyEl.value
    if (b) {
      const r = b.getBoundingClientRect(), edge = 72
      const v = liftY < r.top + edge ? -(r.top + edge - liftY) : liftY > r.bottom - edge ? liftY - (r.bottom - edge) : 0
      if (v) b.scrollTop += Math.max(-14, Math.min(14, v * 0.2))
    }
    placeLift()
    liftRaf = requestAnimationFrame(tick)
  }
  liftRaf = requestAnimationFrame(tick)
}
function placeLift() {
  if (liftFrom.value < 0) return
  liftDy.value = liftY - liftY0 + ((bodyEl.value?.scrollTop ?? 0) - liftScroll0)
  // insertion slot from the other rows' midpoints
  const els = [...(bodyEl.value?.querySelectorAll<HTMLElement>('.row[data-i]') ?? [])]
  let slot = els.length
  for (const el of els) {
    const j = Number(el.dataset.i)
    if (j === liftFrom.value) continue
    const r = el.getBoundingClientRect()
    if (liftY < r.top + r.height / 2) { slot = j; break }
  }
  dropAt.value = slot === liftFrom.value || slot === liftFrom.value + 1 ? -1 : slot
}
function gripMove(e: PointerEvent) { if (liftFrom.value >= 0) { liftY = e.clientY; placeLift() } }
function gripUp() {
  if (liftFrom.value < 0) return
  cancelAnimationFrame(liftRaf)
  const from = liftFrom.value, slot = dropAt.value
  liftFrom.value = -1; liftDy.value = 0; dropAt.value = -1
  if (slot >= 0) moveTrack(lib.viewId, from, slot > from ? slot - 1 : slot)
}
onBeforeUnmount(() => cancelAnimationFrame(liftRaf))

// ── menus ──
const plBtn = ref<HTMLElement>(), addBtn = ref<HTMLElement>(), moreBtn = ref<HTMLElement>()
const plOpen = ref(false), addOpen = ref(false), moreOpen = ref(false)
const creating = ref(false), newName = ref(''), newInput = ref<HTMLInputElement>()
async function startCreate() { creating.value = true; newName.value = ''; await nextTick(); newInput.value?.focus() }
function commitCreate() { if (newName.value.trim()) { createPlaylist(newName.value); query.value = '' } creating.value = false; plOpen.value = false }
function choose(id: number) { viewPlaylist(id); plOpen.value = false; query.value = '' }

// playlist title rename (inline in the header)
const renaming = ref(false), renameText = ref(''), renameInput = ref<HTMLInputElement>()
async function startRename() { moreOpen.value = false; renaming.value = true; renameText.value = viewed.value?.name ?? ''; await nextTick(); renameInput.value?.select() }
function commitRename() { if (renaming.value && viewed.value) renamePlaylist(viewed.value.id, renameText.value); renaming.value = false }

// destructive actions confirm in place (second click)
const sure = ref<'' | 'clear' | 'delete'>('')
function confirm(what: 'clear' | 'delete') {
  if (sure.value !== what) { sure.value = what; return }
  if (what === 'clear') clearPlaylist(lib.viewId); else deletePlaylist(lib.viewId)
  sure.value = ''; moreOpen.value = false
}
function closeMore() { moreOpen.value = false; sure.value = '' }

// per-row menu (one popover, re-anchored)
const rowAnchor = ref<HTMLElement | null>(null), rowOpen = ref(false), rowTrack = ref<Track | null>(null)
function openRow(t: Track, e: MouseEvent) {
  const a = e.currentTarget as HTMLElement
  if (rowOpen.value && rowAnchor.value === a) { rowOpen.value = false; return }
  rowAnchor.value = a; rowTrack.value = t; rowOpen.value = true
}
const otherLists = computed(() => lib.playlists.filter(p => p.id !== lib.viewId))
function rowAct(fn: () => void) { fn(); rowOpen.value = false }
</script>

<template>
  <div v-if="layout.mobile" class="scrim" :class="{ on: sheet }" aria-hidden="true" @click="setSheet(false)" />
  <aside
    class="side" :class="{ mobile: layout.mobile, open: sheet || docked, docked, dragging: sheetDy !== 0, gone: libraryEmpty }" :style="sheetStyle"
    :aria-hidden="libraryEmpty || undefined" :inert="libraryEmpty || undefined"
    :aria-label="layout.mobile ? 'Player' : undefined"
  >
    <!-- ───────── phones: grab zone = handle + mini player (closed) / header (open). Drag or flick it; a tap on
         the closed mini player opens the sheet, a tap on the open header does nothing (use ⌄ or the handle) ───────── -->
    <div
      v-if="layout.mobile" class="grab" :class="{ scrolled: bodyScrolled }"
      @pointerdown="gDown" @pointermove="gMove" @pointerup="gUp" @pointercancel="gUp"
    >
      <button class="handle" :aria-label="sheet ? 'Collapse player' : 'Expand player'" :aria-expanded="sheet" @click.stop="$event.detail === 0 && setSheet(!sheet, false, true)"><i /></button>
      <div class="mini" :aria-hidden="sheet">
        <div class="mcover">
          <img v-if="current?.coverUrl" :src="current.coverUrl" alt="">
          <Disc3 v-else :size="22" :stroke-width="1.5" />
          <span v-if="current && playing" class="mlive" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <div class="mtitles">
          <b>{{ current?.title ?? 'Nothing playing' }}</b>
          <span v-if="status.loading" class="busy"><i class="spin" />{{ status.stage }}</span>
          <span v-else>{{ current ? current.artist || 'Unknown artist' : 'Tap to open your library' }}</span>
        </div>
        <button class="mbtn" :tabindex="sheet ? -1 : 0" :disabled="!current" aria-label="Previous track" @click.stop="prev()">
          <SkipBack :size="19" :stroke-width="1.6" fill="currentColor" />
        </button>
        <button class="mbtn play" :tabindex="sheet ? -1 : 0" :disabled="!current" :aria-label="playing ? 'Pause' : 'Play'" @click.stop="toggle()">
          <svg class="ring" viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="22" class="track" />
            <circle ref="mring" cx="24" cy="24" r="22" class="prog" pathLength="100" />
          </svg>
          <Pause v-if="playing" :size="18" :stroke-width="0" fill="currentColor" />
          <Play v-else :size="18" :stroke-width="0" fill="currentColor" class="nudge" />
        </button>
        <button class="mbtn" :tabindex="sheet ? -1 : 0" :disabled="!hasNext" aria-label="Next track" @click.stop="next()">
          <SkipForward :size="19" :stroke-width="1.6" fill="currentColor" />
        </button>
      </div>
      <div class="shead" :aria-hidden="!sheet">
        <button ref="closeBtn" class="sbtn close" :tabindex="sheet ? 0 : -1" aria-label="Close player" @click.stop="setSheet(false)">
          <ChevronDown :size="22" :stroke-width="2.2" />
        </button>
        <div class="from">
          <small>Playing from</small>
          <b>{{ playingFrom }}</b>
        </div>
        <button class="sbtn" :tabindex="sheet || docked ? 0 : -1" aria-label="Settings" @click.stop="ui.settings = true">
          <Settings2 :size="20" :stroke-width="1.9" />
        </button>
      </div>
    </div>

    <div ref="bodyEl" class="body" :inert="layout.mobile && !sheet && !docked" @scroll.passive="onBodyScroll">
    <!-- ───────── now playing ───────── -->
    <section class="now">
      <button v-if="!layout.mobile" class="gear" title="Settings" aria-label="Settings" @click="ui.settings = true"><Settings2 :size="17" :stroke-width="1.9" /></button>
      <div class="np">
        <div class="cover">
          <img v-if="current?.coverUrl" :src="current.coverUrl" alt="">
          <Disc3 v-else :size="30" :stroke-width="1.4" />
        </div>
        <div class="titles">
          <h1 :title="current?.title">{{ current?.title ?? 'Nothing playing' }}</h1>
          <p>{{ current ? current.artist || 'Unknown artist' : 'Add music to get started' }}</p>
          <div class="facts">
            <Transition name="fade" mode="out-in">
              <span v-if="status.loading" key="l" class="busy"><i class="spin" />{{ status.stage }} · {{ Math.round(status.progress * 100) }}%</span>
              <span v-else-if="bpm && current" key="f" class="chips"><span class="chip">{{ bpm }} BPM</span><span v-if="keyName" class="chip">{{ keyName }}</span></span>
            </Transition>
          </div>
        </div>
      </div>

      <div class="seek" :class="{ off: !current }">
        <span ref="tNow" class="t">0:00</span>
        <div
          ref="track" class="scrub" :class="{ drag: scrubDrag }"
          role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" :aria-valuemax="Math.round(duration || 0)"
          @keydown="onSeekKey"
          @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="cancel" @pointerleave="leave"
        >
          <div class="bar"><i ref="fill" class="fill" /><i v-show="hovering && !scrubDrag" ref="ghost" class="ghost" /></div>
          <span class="kclip"><span ref="knob" class="krail"><i class="knob" /></span></span>
          <span v-show="hovering || scrubDrag" ref="bubble" class="bubble" />
        </div>
        <span class="t">{{ current ? fmt(duration) : '0:00' }}</span>
      </div>

      <div class="transport">
        <button class="mode" :class="{ on: lib.shuffle }" :title="lib.shuffle ? 'Shuffle on (S)' : 'Shuffle off (S)'" @click="toggleShuffle()">
          <Shuffle :size="16" :stroke-width="2" />
        </button>
        <button class="skip" :disabled="!current" title="Previous (P)" @click="prev()">
          <SkipBack :size="18" :stroke-width="1.6" fill="currentColor" />
        </button>
        <button class="main" :class="{ on: playing }" :disabled="!current" :title="playing ? 'Pause (space)' : 'Play (space)'" @click="toggle()">
          <Pause v-if="playing" :size="19" :stroke-width="0" fill="currentColor" />
          <Play v-else :size="19" :stroke-width="0" fill="currentColor" class="nudge" />
        </button>
        <button class="skip" :disabled="!hasNext" title="Next (N)" @click="next()">
          <SkipForward :size="18" :stroke-width="1.6" fill="currentColor" />
        </button>
        <button class="mode" :class="{ on: lib.repeat !== 'off' }" :title="`Repeat ${lib.repeat} (R)`" @click="cycleRepeat()">
          <Repeat1 v-if="lib.repeat === 'one'" :size="16" :stroke-width="2" />
          <Repeat v-else :size="16" :stroke-width="2" />
        </button>
      </div>

      <div class="vol" @wheel.prevent="onVolWheel">
        <button class="icon" :title="lib.muted ? 'Unmute (M)' : 'Mute (M)'" @click="toggleMute()">
          <VolumeX v-if="lib.muted || lib.volume === 0" :size="16" :stroke-width="1.9" />
          <Volume1 v-else-if="lib.volume < 0.5" :size="16" :stroke-width="1.9" />
          <Volume2 v-else :size="16" :stroke-width="1.9" />
        </button>
        <div
          ref="vtrack" class="vslider" :class="{ drag: vDrag }" role="slider" tabindex="0" aria-label="Volume"
          :aria-valuenow="Math.round(volPct)" aria-valuemin="0" aria-valuemax="100"
          @pointerdown="vDown" @pointermove="vMove" @pointerup="vUp" @pointercancel="vUp" @keydown="onVolKey"
        >
          <div class="vbar"><i class="vfill" :style="{ width: volPct + '%' }" /></div>
          <i class="vknob" :style="{ left: volPct + '%' }" />
        </div>
        <span class="vpct">{{ Math.round(volPct) }}</span>
      </div>
    </section>

    <!-- ───────── playlist ───────── -->
    <section class="lists">
      <header>
        <input
          v-if="renaming" ref="renameInput" v-model="renameText" class="rename" aria-label="Playlist name"
          @keydown.enter="commitRename" @keydown.esc="renaming = false" @blur="commitRename"
        >
        <button v-else ref="plBtn" class="pl-btn" :class="{ open: plOpen }" @click="plOpen = !plOpen">
          <ListMusic :size="17" :stroke-width="1.8" class="lead" />
          <span>{{ viewed?.name ?? 'Playlist' }}</span>
          <ChevronDown :size="16" :stroke-width="2" class="chev" />
        </button>
        <div class="actions">
          <button class="icon" :class="{ on: searchOpen }" title="Search" @click="toggleSearch"><Search :size="17" :stroke-width="1.9" /></button>
          <button ref="addBtn" class="icon" :class="{ on: addOpen }" title="Add music" @click="addOpen = !addOpen"><Plus :size="18" :stroke-width="1.9" /></button>
          <button ref="moreBtn" class="icon" :class="{ on: moreOpen }" title="Playlist options" @click="moreOpen = !moreOpen"><Ellipsis :size="18" :stroke-width="1.9" /></button>
        </div>
      </header>

      <Transition name="slide">
        <div v-if="searchOpen" class="search">
          <Search :size="15" :stroke-width="1.9" />
          <input ref="searchInput" v-model="query" placeholder="Search this playlist" spellcheck="false" @keydown.esc="toggleSearch">
          <button v-if="query" class="clear-q" title="Clear search" @click="query = ''"><X :size="14" :stroke-width="2" /></button>
        </div>
      </Transition>

      <div class="stats">
        {{ viewTracks.length }} {{ viewTracks.length === 1 ? 'track' : 'tracks' }}<template v-if="totalDuration"> · {{ fmtLong(totalDuration) }}</template><template v-if="unavailable"> · <span class="bad">{{ unavailable }} unavailable</span></template>
        <template v-if="!isPlayingHere && lib.currentId != null"> · playing from another playlist</template>
      </div>

      <ol ref="listEl" class="rows" @scroll.passive="queueRange">
        <li v-if="!viewTracks.length" class="empty">
          <Music :size="22" :stroke-width="1.5" />
          <span>No tracks yet</span>
          <small>Drop files or folders here, paste links, or use + to add music.</small>
        </li>
        <li v-else-if="!rows.length" class="empty"><span>No matches for “{{ query }}”</span></li>
        <li v-if="padTop" class="vpad" :style="{ height: padTop + 'px' }" aria-hidden="true" />
        <li
          v-for="{ t, i } in shown" :key="t.id" class="row"
          :class="{ cur: isCur(t.id), failed: !!t.failed, drop: dropAt === i, 'drop-end': dropAt === rows.length && i === rows.length - 1, menu: rowOpen && rowTrack?.id === t.id, lifted: liftFrom === i }"
          :style="liftFrom === i ? { transform: `translateY(${liftDy}px)` } : undefined"
          :data-i="i"
          :draggable="canReorder && !layout.mobile"
          @click="pick(t.id)"
          @dragstart="onDragStart(i, $event)" @dragover="onDragOver(i, $event)" @drop="onDrop(i, $event)" @dragend="onDragEnd"
        >
          <span class="num">
            <TriangleAlert v-if="t.failed" :size="15" :stroke-width="2" class="warn" />
            <AudioLines v-else-if="isCur(t.id)" :size="16" :stroke-width="2" :class="{ live: playing && !status.loading }" />
            <template v-else><b>{{ i + 1 }}</b><Play :size="14" :stroke-width="0" fill="currentColor" class="hover-play" /></template>
          </span>
          <div class="art">
            <img v-if="t.coverUrl" :src="t.coverUrl" alt="">
            <Music v-else :size="16" :stroke-width="1.6" />
          </div>
          <div class="meta">
            <b :title="t.failed ? `Can’t play — ${t.failed}` : t.title">{{ t.title }}</b>
            <span v-if="t.failed" class="why">Can’t play — {{ t.failed }}</span>
            <span v-else><Link2 v-if="t.url && !isDeviceUrl(t.url)" :size="11" :stroke-width="2.2" class="lk" />{{ t.artist || 'Unknown artist' }}<template v-if="layout.mobile && t.duration"> · {{ fmt(t.duration) }}</template></span>
          </div>
          <span class="dur">{{ t.duration ? fmt(t.duration) : '' }}</span>
          <button class="row-more" title="More" :aria-label="`More for ${t.title}`" @click.stop="openRow(t, $event)"><Ellipsis :size="17" :stroke-width="1.9" /></button>
          <span
            v-if="layout.mobile" class="grip" :class="{ off: !canReorder }" role="button" :aria-label="`Reorder ${t.title}`"
            @pointerdown.stop="gripDown(i, $event)" @pointermove="gripMove" @pointerup="gripUp" @pointercancel="gripUp" @click.stop
          ><GripVertical :size="18" :stroke-width="1.9" /></span>
        </li>
        <li v-if="padBottom" class="vpad" :style="{ height: padBottom + 'px' }" aria-hidden="true" />
      </ol>
    </section>
    </div>

    <!-- ───────── menus ───────── -->
    <Popover :anchor="plBtn ?? null" :open="plOpen" :width="250" @close="plOpen = false; creating = false">
      <div class="gm-label">Playlists</div>
      <button v-for="p in lib.playlists" :key="p.id" class="gm-item" :class="{ on: p.id === lib.viewId }" @click="choose(p.id)">
        <Check v-if="p.id === lib.viewId" :size="16" /><span v-else style="width: 16px" />
        <span class="gm-grow">{{ p.name }}</span>
        <AudioLines v-if="p.id === lib.playingId && lib.currentId != null" :size="14" />
        <span class="gm-note">{{ p.trackIds.length }}</span>
      </button>
      <div class="gm-sep" />
      <div v-if="creating" style="padding: 4px">
        <input ref="newInput" v-model="newName" class="gm-input" placeholder="Playlist name" @keydown.enter="commitCreate" @keydown.esc="creating = false">
      </div>
      <button v-else class="gm-item" @click="startCreate"><Plus :size="16" /><span class="gm-grow">New playlist</span></button>
    </Popover>

    <Popover :anchor="addBtn ?? null" :open="addOpen" align="right" :width="210" @close="addOpen = false">
      <label class="gm-item"><Music :size="16" /><span class="gm-grow">Add files…</span><input type="file" accept="audio/*" multiple @change="onAdd"></label>
      <button v-if="isNative" class="gm-item" @click="scanNow"><Smartphone :size="16" /><span class="gm-grow">Scan this phone</span></button>
      <label v-if="!isNative" class="gm-item"><FolderPlus :size="16" /><span class="gm-grow">Add a folder…</span><input type="file" webkitdirectory multiple @change="onAdd"></label>
      <button class="gm-item" @click="openLinks"><Link2 :size="16" /><span class="gm-grow">Add from links…</span><span v-if="!isNative" class="gm-note">⌘V</span></button>
    </Popover>

    <Popover :anchor="moreBtn ?? null" :open="moreOpen" align="right" :width="230" @close="closeMore">
      <button class="gm-item" @click="startRename"><Pencil :size="16" /><span class="gm-grow">Rename playlist</span></button>
      <button class="gm-item" :disabled="viewTracks.length < 2" @click="reversePlaylist(); moreOpen = false"><ArrowUpDown :size="16" /><span class="gm-grow">Reverse order</span></button>
      <button class="gm-item" :disabled="viewTracks.length < 2" @click="removeDuplicates(); moreOpen = false"><CopyX :size="16" /><span class="gm-grow">Remove duplicates</span></button>
      <div class="gm-sep" />
      <button class="gm-item danger" @click="confirm('clear')"><X :size="16" /><span class="gm-grow">{{ sure === 'clear' ? 'Click again to clear' : 'Clear playlist' }}</span></button>
      <button class="gm-item danger" @click="confirm('delete')"><Trash2 :size="16" /><span class="gm-grow">{{ sure === 'delete' ? 'Click again to delete' : 'Delete playlist' }}</span></button>
    </Popover>

    <Popover :anchor="rowAnchor" :open="rowOpen" align="right" :width="230" @close="rowOpen = false">
      <template v-if="rowTrack">
        <template v-if="rowTrack.failed">
          <div class="gm-label">Can’t play — {{ rowTrack.failed }}</div>
          <button class="gm-item" @click="rowAct(() => retryTrack(rowTrack!.id))"><RotateCcw :size="16" /><span class="gm-grow">Try again</span></button>
        </template>
        <button v-else class="gm-item" @click="rowAct(() => playTrack(rowTrack!.id, lib.viewId, true))"><Play :size="16" /><span class="gm-grow">Play now</span></button>
        <button v-if="lib.currentId != null && rowTrack.id !== lib.currentId && !rowTrack.failed" class="gm-item" @click="rowAct(() => playNext(rowTrack!.id))"><ListEnd :size="16" /><span class="gm-grow">Play next</span></button>
        <template v-if="otherLists.length">
          <div class="gm-sep" />
          <div class="gm-label">Add to playlist</div>
          <button v-for="p in otherLists" :key="p.id" class="gm-item" @click="rowAct(() => addToPlaylist(p.id, rowTrack!.id))">
            <Check v-if="p.trackIds.includes(rowTrack.id)" :size="16" /><ListPlus v-else :size="16" />
            <span class="gm-grow">{{ p.name }}</span>
          </button>
        </template>
        <div class="gm-sep" />
        <button class="gm-item danger" @click="rowAct(() => removeFromPlaylist(lib.viewId, rowTrack!.id))"><Trash2 :size="16" /><span class="gm-grow">Remove from playlist</span></button>
      </template>
    </Popover>
  </aside>
</template>

<style scoped>
.side {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 6; display: flex; flex-direction: column;
  background: linear-gradient(180deg, rgba(22, 19, 21, .78), rgba(13, 12, 13, .86));
  backdrop-filter: blur(18px); border-left: 1px solid rgba(255, 255, 255, .05);
  color: #e6e0e2;
  /* installed app with the title bar hidden: keep content below Chrome's floating window controls */
  padding-top: env(titlebar-area-height, 0px);
}
button { all: unset; box-sizing: border-box; cursor: pointer; }
button:focus-visible { outline: 2px solid rgba(255, 155, 128, .6); outline-offset: 2px; }

/* ── now playing ── */
.now { position: relative; padding: 26px 26px 18px; }
.gear { position: absolute; top: 10px; right: 10px; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; color: #6f686d; transition: color .15s, background .15s; }
.gear:hover { color: #f1ecee; background: rgba(255, 255, 255, .06); }
.np { display: flex; gap: 16px; align-items: center; }
.cover { width: 76px; height: 76px; flex: none; border-radius: 12px; overflow: hidden; display: grid; place-items: center;
  background: linear-gradient(140deg, #3d1f2a, #6b2c45); color: rgba(255, 220, 205, .75);
  box-shadow: 0 12px 28px rgba(0, 0, 0, .45), inset 0 0 0 1px rgba(255, 255, 255, .06); }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.titles { min-width: 0; flex: 1; }
h1 { margin: 0; font-size: 16.5px; font-weight: 600; letter-spacing: -.01em; color: #f6f3f4; line-height: 1.3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.titles p { margin: 3px 0 0; font-size: 13px; color: #9d979c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.facts { margin-top: 9px; min-height: 16px; font-size: 11.5px; font-weight: 500; letter-spacing: .03em; color: #d79a87; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.busy { display: inline-flex; align-items: center; gap: 8px; color: #8e8990; font-weight: 400; }
.spin { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid rgba(255, 122, 89, .25); border-top-color: #ff7a59; animation: spin .8s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }

/* seek: full-width bar with the times underneath (same layout on desktop and in the phone sheet) */
.seek { display: grid; grid-template-columns: 1fr 1fr; grid-template-areas: "bar bar" "a b"; margin: 18px 0 0; }
.seek.off { opacity: .5; pointer-events: none; }
.seek .t { font-size: 11px; color: #7a747b; font-variant-numeric: tabular-nums; }
.seek .t:first-child { grid-area: a; }
.seek .t:last-child { grid-area: b; text-align: right; }
.scrub { grid-area: bar; position: relative; height: 26px; cursor: pointer; touch-action: none; outline: none; }
/* the knob rail is translated across (and past) the bar: it lives in a frame just wider than the bar (room for the
   knob at both ends) that clips it, so it can never widen the page or let the phone sheet scroll sideways */
.kclip { position: absolute; left: -10px; right: -10px; top: -12px; bottom: -12px; overflow: hidden; pointer-events: none; }
.kclip .krail { left: 10px; right: 10px; }
.bar { position: absolute; left: 0; right: 0; top: 50%; height: 4px; margin-top: -2px; border-radius: 4px; background: rgba(255, 255, 255, .09); overflow: hidden; transition: height .15s, margin .15s; }
.fill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; transform: scaleX(0); transform-origin: 0 50%; background: linear-gradient(90deg, #b99a8f, #f4e7df); will-change: transform; }
/* the knob sits at the rail's left edge; translating the rail by f·100% (of its own width) puts it at f */
.krail { position: absolute; left: 0; right: 0; top: 50%; height: 0; pointer-events: none; will-change: transform; }
.ghost { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(255, 255, 255, .08); pointer-events: none; }
.knob { position: absolute; left: 0; top: 0; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 6px rgba(0, 0, 0, .5); transition: transform .15s; pointer-events: none; }
.scrub:hover .bar, .scrub.drag .bar, .scrub:focus-visible .bar { height: 6px; margin-top: -3px; }
.scrub:hover .knob, .scrub:focus-visible .knob { transform: scale(1.15); }
.scrub.drag .knob { transform: scale(1.3); }
.scrub:focus-visible .knob { box-shadow: 0 0 0 4px rgba(255, 122, 89, .3), 0 1px 6px rgba(0, 0, 0, .5); }
.bubble { position: absolute; bottom: calc(100% + 2px); transform: translateX(-50%); padding: 3px 7px; border-radius: 6px; pointer-events: none;
  font-size: 10.5px; color: #f1ecee; background: rgba(30, 26, 29, .95); border: 1px solid rgba(255, 255, 255, .07); font-variant-numeric: tabular-nums; white-space: nowrap; }

.transport { display: grid; grid-template-columns: 1fr 1fr auto 1fr 1fr; align-items: center; justify-items: center; margin: 12px 18px 0; }
.mode, .skip, .icon { display: grid; place-items: center; border-radius: 50%; transition: color .15s, background .15s, transform .12s; }
.mode { position: relative; width: 32px; height: 32px; color: #7d777e; }
.mode:hover { color: #ece6e8; background: rgba(255, 255, 255, .05); }
.mode.on { color: #ffa48c; }
.mode.on::after { content: ""; position: absolute; bottom: 0; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: currentColor; }
.skip { width: 36px; height: 36px; color: #ece6e8; }
.skip:hover { background: rgba(255, 255, 255, .06); }
.skip:active { transform: scale(.92); }
.skip:disabled, .main:disabled { opacity: .28; pointer-events: none; box-shadow: none; }
.main { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 50%; color: #1d1316; background: #f4e7df;
  box-shadow: 0 8px 18px rgba(0, 0, 0, .35); transition: transform .12s, box-shadow .25s, background .25s; }
.main .nudge { margin-left: 2px; }
.main:hover { transform: scale(1.04); background: #fff; }
.main:active { transform: scale(.95); }
.main.on { box-shadow: 0 8px 18px rgba(0, 0, 0, .35), 0 0 0 5px rgba(255, 122, 89, .12); }

.icon { width: 34px; height: 34px; color: #8f888f; border-radius: 9px; flex: none; }
.icon:hover, .icon.on { color: #f3edef; background: rgba(255, 255, 255, .06); }

.vol { display: flex; align-items: center; gap: 10px; margin: 14px 2px 0; padding: 6px 10px 6px 4px; border-radius: 12px; background: rgba(255, 255, 255, .03); }
.vol .icon { width: 30px; height: 30px; }
.vslider { position: relative; flex: 1; height: 22px; cursor: pointer; touch-action: none; outline: none; }
.vbar { position: absolute; left: 0; right: 0; top: 50%; height: 4px; margin-top: -2px; border-radius: 4px; background: rgba(255, 255, 255, .09); overflow: hidden; transition: height .15s, margin .15s; }
.vfill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: inherit; background: linear-gradient(90deg, #b99a8f, #f4e7df); }
.vknob { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 6px rgba(0, 0, 0, .5); transform: scale(0); transition: transform .15s; pointer-events: none; }
.vslider:hover .vbar, .vslider.drag .vbar, .vslider:focus-visible .vbar { height: 6px; margin-top: -3px; }
.vslider:hover .vknob, .vslider.drag .vknob, .vslider:focus-visible .vknob { transform: scale(1); }
.vpct { width: 24px; text-align: right; font-size: 11px; color: #7a747b; font-variant-numeric: tabular-nums; }

/* ── playlist ── */
.lists { flex: 1; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid rgba(255, 255, 255, .05); }
.lists header { display: flex; align-items: center; gap: 8px; padding: 14px 16px 6px 18px; }
.pl-btn { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 8px; border-radius: 10px; transition: background .15s; }
.pl-btn:hover, .pl-btn.open { background: rgba(255, 255, 255, .05); }
.pl-btn .lead { color: #c98f7e; flex: none; }
.pl-btn span { min-width: 0; font-size: 14.5px; font-weight: 600; color: #f1ecee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-btn .chev { flex: none; color: #7d777e; transition: transform .2s; }
.pl-btn.open .chev { transform: rotate(180deg); }
.rename { all: unset; flex: 1; min-width: 0; box-sizing: border-box; padding: 7px 10px; border-radius: 10px; font-size: 14.5px; font-weight: 600; color: #fff;
  background: rgba(0, 0, 0, .3); border: 1px solid rgba(255, 155, 128, .45); }
.actions { display: flex; gap: 2px; flex: none; }

.search { display: flex; align-items: center; gap: 8px; margin: 2px 18px 4px; padding: 8px 10px; border-radius: 10px; background: rgba(255, 255, 255, .05); color: #7d777e; }
.search input { all: unset; flex: 1; min-width: 0; font-size: 13px; color: #ece6e8; }
.search input::placeholder { color: #67626a; }
.clear-q { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; color: #8f888f; }
.clear-q:hover { color: #fff; background: rgba(255, 255, 255, .08); }
.stats { padding: 4px 28px 8px; font-size: 11.5px; color: #6c676e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.rows { list-style: none; margin: 0; padding: 0 10px 16px 12px; overflow-y: auto; flex: 1; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .14) transparent; }
.rows::-webkit-scrollbar { width: 10px; }
.rows::-webkit-scrollbar-track { background: transparent; }
.rows::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .12); border-radius: 10px; border: 3px solid transparent; background-clip: padding-box; }
.rows:hover::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, .2); }

.vpad { list-style: none; pointer-events: none; }
.row { height: 56px; box-sizing: border-box; display: grid; grid-template-columns: 26px 42px minmax(0, 1fr) auto 30px; align-items: center; column-gap: 12px;
  padding: 7px 6px 7px 8px; border-radius: 10px; cursor: pointer; position: relative; transition: background .15s; }
.row:hover, .row.menu { background: rgba(255, 255, 255, .045); }
.row.cur { background: rgba(255, 122, 89, .08); }
.row.drop::before { content: ""; position: absolute; left: 10px; right: 10px; top: -1px; height: 2px; border-radius: 2px; background: #ffa48c; }
.row[draggable="true"]:active { cursor: grabbing; }
.num { display: grid; place-items: center; font-size: 12px; color: #6f6970; font-variant-numeric: tabular-nums; }
.num b { font-weight: 500; }
.num .hover-play { display: none; color: #f1ecee; }
.row:hover .num b { display: none; }
.row:hover .num .hover-play { display: block; }
.num .live { color: #ffa48c; animation: pulse 1.1s ease-in-out infinite; }
.row.cur .num { color: #ffa48c; }
@keyframes pulse { 50% { opacity: .45; } }
.art { width: 42px; height: 42px; border-radius: 7px; overflow: hidden; display: grid; place-items: center;
  background: linear-gradient(140deg, #3d1f2a, #6b2c45); color: rgba(255, 220, 205, .6); }
.art img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.meta { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.meta b { font-size: 13.5px; font-weight: 500; color: #ebe6e8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.cur .meta b { color: #ffc2b2; }
.meta span { font-size: 12px; color: #7d777e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dur { font-size: 12px; color: #6f6970; font-variant-numeric: tabular-nums; }
/* tracks flagged as unplayable: dimmed, with the reason under the title; skipped by playback */
.row.failed .art, .row.failed .meta b, .row.failed .dur { opacity: .45; }
.row.failed .num .warn { color: #e0866e; }
.row.failed:hover .num b, .row.failed .hover-play { display: none !important; }
.meta .why { color: #c98472; }
.meta .lk { display: inline-block; vertical-align: -1px; margin-right: 4px; color: #8f7f86; }
.stats .bad { color: #d48b78; }
.row-more { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: #8f888f; opacity: 0; transition: opacity .15s, background .15s; }
.row:hover .row-more, .row.menu .row-more { opacity: 1; }
.row-more:hover, .row.menu .row-more { color: #fff; background: rgba(255, 255, 255, .08); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 36px 20px; color: #8a848b; text-align: center; }
.empty span { font-size: 13.5px; color: #cfc8cb; }
.empty small { font-size: 12px; color: #6f6970; line-height: 1.5; }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.chip + .chip::before { content: " · "; }

/* ── phones: bottom sheet ── */
.scrim { position: fixed; inset: 0; z-index: 6; background: rgba(4, 3, 4, .45); opacity: 0; pointer-events: none; transition: opacity .35s;
  backdrop-filter: blur(10px) saturate(.9); }
.scrim.on { opacity: 1; pointer-events: auto; }
.side.mobile {
  top: auto; left: 0; right: 0; bottom: 0; z-index: 7; padding-top: 0;
  border-left: 0; border-top: 1px solid rgba(255, 255, 255, .08); border-radius: 24px 24px 0 0;
  background: none; backdrop-filter: none;
  box-shadow: 0 -16px 40px rgba(0, 0, 0, .5);
  transition: transform .44s cubic-bezier(.2, .85, .25, 1), opacity .35s, border-color .3s, box-shadow .3s;
}
/* the panel itself lives on a layer so it can fade away when the sheet closes */
.side.mobile::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
  background: linear-gradient(180deg, rgba(30, 25, 28, .97), rgba(14, 12, 13, .985) 220px); transition: opacity .3s; }
.side.mobile.dragging { transition: none; }
/* docked (analysis off): the player lives in the page under the record — a calm panel, nothing to drag */
.side.mobile.docked { transition: opacity .35s; border-radius: 26px 26px 0 0; box-shadow: 0 -10px 30px rgba(0, 0, 0, .35); }
.side.mobile.docked .handle, .side.mobile.docked .mini { display: none; }
.side.mobile.docked .grab { cursor: default; }
.side.mobile.docked .shead { padding-top: 6px; }
.side.mobile.docked .sbtn.close { visibility: hidden; }
/* nothing in the library yet: the mini player stays tucked below the screen, then slides up with the first song */
.side.mobile.gone { transform: translateY(calc(100% + 40px)) !important; opacity: 0; pointer-events: none; }
/* closed: no panel behind the mini player — the card floats on its own (the panel shows while it is pulled up) */
.side.mobile:not(.open):not(.dragging) { border-color: transparent; box-shadow: none; }
.side.mobile:not(.open):not(.dragging)::before { opacity: 0; }
.side.mobile:not(.open):not(.dragging) .handle i { opacity: 0; }

/* grab zone: handle + (closed) mini player card / (open) header — the whole strip is the drag target */
.grab { flex: none; position: relative; touch-action: none; cursor: grab; transition: box-shadow .25s; }
.grab.scrolled { box-shadow: 0 1px 0 rgba(255, 255, 255, .06), 0 10px 18px -12px rgba(0, 0, 0, .7); z-index: 1; }
.handle { display: grid; place-items: center; width: 64px; height: 22px; margin: 0 auto; border-radius: 0 0 10px 10px; }
.handle i { display: block; width: 38px; height: 5px; border-radius: 5px; background: rgba(255, 255, 255, .22); transition: background .2s; }
.handle:focus-visible { outline: none; }
.handle:focus-visible i { background: #ffa48c; }

/* closed: a floating card with real breathing room above the screen edge */
.mini { display: flex; align-items: center; gap: 4px; height: 64px; margin: 0 10px 12px; padding: 0 4px 0 8px;
  /* frosted glass: the stage shows through, blurred (standard property only — the CSS minifier drops it when a
     -webkit- duplicate is present) */
  border-radius: 18px; background: rgba(32, 27, 30, .72); backdrop-filter: blur(18px) saturate(1.25);
  border: 1px solid rgba(255, 255, 255, .08); box-shadow: 0 14px 34px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .3);
  transition: height .34s cubic-bezier(.2, .85, .25, 1), opacity .2s, margin .34s; }
.side.open .mini { height: 0; margin-bottom: 0; opacity: 0; pointer-events: none; overflow: hidden; border-width: 0; }
.mcover { position: relative; width: 48px; height: 48px; flex: none; border-radius: 12px; overflow: hidden; display: grid; place-items: center;
  background: linear-gradient(140deg, #3d1f2a, #6b2c45); color: rgba(255, 220, 205, .75); box-shadow: 0 6px 14px rgba(0, 0, 0, .4); }
.mcover img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
/* tiny equaliser over the cover while playing */
.mlive { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: center; gap: 2px; padding-bottom: 9px;
  background: linear-gradient(180deg, transparent 30%, rgba(0, 0, 0, .55)); }
.mlive i { width: 3px; height: 12px; border-radius: 2px; background: #ffd2c4; transform-origin: 50% 100%; animation: eq .9s ease-in-out infinite; }
.mlive i:nth-child(2) { animation-delay: -.3s; }
.mlive i:nth-child(3) { animation-delay: -.6s; }
@keyframes eq { 0%, 100% { transform: scaleY(.35); } 50% { transform: scaleY(1); } }
.mtitles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; margin: 0 6px 0 8px; }
.mtitles b { font-size: 15px; font-weight: 600; color: #f6f3f4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mtitles span { font-size: 13px; color: #a7a0a5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mbtn { position: relative; flex: none; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; color: #f1ecee; transition: transform .12s; }
.mbtn:active { transform: scale(.9); }
.mbtn:disabled { opacity: .3; }
/* play button wears the track progress as a ring */
.mbtn.play { width: 48px; height: 48px; color: #f6efec; }
.mbtn.play::before { content: ""; position: absolute; inset: 5px; border-radius: 50%; background: rgba(255, 255, 255, .08); }
.mbtn.play > :not(.ring) { position: relative; }
.ring { position: absolute; inset: 0; width: 48px; height: 48px; transform: rotate(-90deg); pointer-events: none; }
.ring circle { fill: none; stroke-width: 2.4; }
.ring .track { stroke: rgba(255, 255, 255, .1); }
.ring .prog { stroke: #ffa48c; stroke-linecap: round; stroke-dasharray: 100; stroke-dashoffset: 100; }
.mbtn .nudge { margin-left: 2px; }

/* open: compact header */
.shead { display: none; align-items: center; gap: 4px; padding: 0 8px 8px; }
.side.open .shead { display: flex; animation: fadeIn .3s ease-out; }
.sbtn { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; color: #d8d2d5; flex: none; transition: background .15s; }
.sbtn:active { background: rgba(255, 255, 255, .08); }
.from { flex: 1; min-width: 0; text-align: center; display: flex; flex-direction: column; gap: 1px; }
.from small { font-size: 10px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: #8b858a; }
.from b { font-size: 14px; font-weight: 600; color: #ece6e8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes fadeIn { from { opacity: 0; } }

/* open sheet body: one scroll (now playing, then the queue) with the app's thin scrollbar */
.side.mobile .body { overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; touch-action: pan-y; transition: opacity .3s;
  scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .16) transparent; }
.side.mobile .body::-webkit-scrollbar { width: 8px; }
.side.mobile .body::-webkit-scrollbar-track { background: transparent; }
.side.mobile .body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .14); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
.side.mobile:not(.open) .body { opacity: 0; pointer-events: none; }

/* compact now playing: cover + titles side by side */
.side.mobile .now { padding: 10px 20px 18px; }
.side.mobile .np { gap: 16px; }
.side.mobile .cover { width: 84px; height: 84px; border-radius: 14px; box-shadow: 0 14px 30px rgba(0, 0, 0, .5), inset 0 0 0 1px rgba(255, 255, 255, .06); }
.side.mobile h1 { font-size: 18px; line-height: 1.25; }
.side.mobile .titles p { font-size: 14px; margin-top: 3px; }
.side.mobile .facts { margin-top: 9px; min-height: 22px; overflow: visible; }
.side.mobile .chips { display: flex; gap: 6px; flex-wrap: wrap; }
.side.mobile .chip { padding: 2px 9px; border-radius: 99px; background: rgba(255, 122, 89, .1); border: 1px solid rgba(255, 164, 140, .18); font-size: 11.5px; color: #f0b3a1; }
.side.mobile .chip + .chip::before { content: none; }

.side.mobile .seek { margin-top: 16px; }
.side.mobile .seek .t { font-size: 11.5px; color: #8f888d; }
.side.mobile .scrub { height: 30px; }
.side.mobile .bar { height: 5px; margin-top: -2.5px; }
.side.mobile .scrub.drag .bar { height: 8px; margin-top: -4px; }
.side.mobile .knob { width: 14px; height: 14px; margin: -7px 0 0 -7px; }
.side.mobile .bubble { bottom: calc(100% + 4px); font-size: 12px; padding: 4px 9px; }

.side.mobile .transport { margin: 6px 0 0; }
.side.mobile .mode { width: 44px; height: 44px; }
.side.mobile .mode svg { width: 20px; height: 20px; }
.side.mobile .skip { width: 52px; height: 52px; }
.side.mobile .skip svg { width: 24px; height: 24px; }
.side.mobile .main { width: 62px; height: 62px; }
.side.mobile .main svg { width: 24px; height: 24px; }
.side.mobile .vol { margin: 14px 0 0; padding: 2px 12px 2px 2px; }
.side.mobile .vol .icon { width: 44px; height: 44px; }
.side.mobile .vslider { height: 34px; }
.side.mobile .vbar { height: 5px; margin-top: -2.5px; }
.side.mobile .vknob { width: 16px; height: 16px; margin: -8px 0 0 -8px; transform: scale(1); }

/* queue */
.side.mobile .lists { flex: none; border-top-color: rgba(255, 255, 255, .06); }
.side.mobile .lists header { padding: 12px 10px 4px 14px; }
.side.mobile .actions .icon { width: 44px; height: 44px; }
.side.mobile .pl-btn { padding: 10px 12px 10px 8px; }
.side.mobile .pl-btn span { font-size: 16px; }
.side.mobile .stats { padding: 0 24px 8px; font-size: 12.5px; }
.side.mobile .search { margin: 2px 14px 6px; padding: 10px 12px; }
.side.mobile .search input { font-size: 16px; } /* ≥16px keeps iOS from zooming on focus */
.side.mobile .rows { overflow: visible; padding: 0 6px calc(24px + env(safe-area-inset-bottom, 0px)) 10px; }
.side.mobile .row { grid-template-columns: 22px 48px minmax(0, 1fr) 40px 40px; column-gap: 10px; padding: 8px 0 8px 4px; height: 64px; }
.side.mobile .num { font-size: 13px; }
.side.mobile .dur { display: none; }
.side.mobile .art { position: relative; width: 48px; height: 48px; border-radius: 9px; }
.side.mobile .meta b { font-size: 15px; }
.side.mobile .meta span { font-size: 13px; }
.side.mobile .row-more { width: 40px; height: 40px; opacity: 1; border-radius: 50%; }
.grip { display: grid; place-items: center; width: 40px; height: 44px; color: #6f6970; touch-action: none; cursor: grab; border-radius: 10px; }
.grip:active { color: #ffb39f; }
.grip.off { opacity: .25; pointer-events: none; }
.side.mobile .row.lifted { z-index: 3; background: rgba(48, 40, 44, .98); box-shadow: 0 14px 30px rgba(0, 0, 0, .55); transition: none; scale: 1.02; }
.side.mobile .row.lifted .grip { color: #ffb39f; }
.row.drop-end::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: #ffa48c; }

/* touch screens have no hover: keep row actions visible and the knobs shown */
@media (hover: none) {
  .row-more { opacity: 1; }
  .vknob { transform: scale(1); }
  .row:hover { background: transparent; }
  .row.cur:hover { background: rgba(255, 122, 89, .08); }
  .row:hover .num b { display: inline; }
  .row:hover .num .hover-play { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .side.mobile, .mini, .scrim, .side.mobile .body { transition-duration: .01s; }
  .side.open .shead { animation: none; }
}

.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.slide-enter-active, .slide-leave-active { transition: opacity .18s, transform .18s; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
