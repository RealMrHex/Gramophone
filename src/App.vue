<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import VinylStage from './components/VinylStage.vue'
import NoteLanes from './components/NoteLanes.vue'
import Sidebar from './components/Sidebar.vue'
import LinkDialog from './components/LinkDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import Visualizer from './components/Visualizer.vue'
import { sampleFrame, settings, tier } from './composables/settings'
import { shareReport } from './composables/diagnostics'
import { analysis, active } from './composables/store'
import { updateLayout } from './composables/layout'
import { audio, onFrame, seek, startLoop, toggle } from './composables/player'
import { addFiles, addLinks, current, cycleRepeat, next, prev, restoreLibrary, scanPhone, scanState, status, toggleMute, toggleShuffle, ui, viewTracks } from './composables/library'
import { isNative, musicAccess, openAppSettings, setupNativeChrome } from './composables/native'
import { setupMediaSession } from './composables/mediaSession'
import { Bug, Link2, Music, RotateCcw, Settings2, Smartphone } from 'lucide-vue-next'
import { extractUrls } from './composables/links'
import { layout } from './composables/layout'
import { collectDropped, collectPicked } from './composables/files'

const grain = ref<HTMLElement>()
/** one 256² tile of monochrome noise; jittering its offset every couple of frames reads as moving film grain */
const grainUrl = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256
  const g = c.getContext('2d')!, img = g.createImageData(256, 256), d = img.data
  for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255 }
  g.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
})()
let grainTick = 0
const dropping = ref(false)

function jumpLine(dir: number) {
  const a = analysis.value; if (!a || !a.lines.length) return
  const cur = active.line, start = a.lines[cur].tokens[0].t0
  let target = dir < 0 ? (audio.currentTime - start > 1 ? cur : cur - 1) : cur + 1
  target = Math.max(0, Math.min(a.lines.length - 1, target))
  seek(a.lines[target].tokens[0].t0)
}

const onKey = (e: KeyboardEvent) => {
  // never while typing (search, rename, the links box) or while a dialog is open
  if (ui.linkDialog || (e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]')) return
  if (e.code === 'KeyS') return toggleShuffle()
  if (e.code === 'KeyR') return cycleRepeat()
  if (e.code === 'KeyM') return toggleMute()
  if (!current.value) return
  if (e.code === 'Space') { e.preventDefault(); toggle() }
  else if (e.code === 'ArrowLeft') seek(audio.currentTime - 5)
  else if (e.code === 'ArrowRight') seek(audio.currentTime + 5)
  else if (e.code === 'ArrowUp') jumpLine(-1)
  else if (e.code === 'ArrowDown') jumpLine(1)
  else if (e.code === 'KeyN') next()
  else if (e.code === 'KeyP') prev()
}
const onPick = (e: Event) => {
  const input = e.target as HTMLInputElement
  if (input.files?.length) {
    const files = collectPicked(input.files)
    if (files.length) addFiles(files); else status.message = 'No audio files found there.'
  }
  input.value = ''
}
/**
 * page-centred, but kept in the free space between the record (left) and the sidebar (right);
 * on narrow windows it centres in that gap and wraps instead of running into the record
 */
const freeBox = computed(() => {
  // phones: centred in the melody band under the record
  if (layout.mobile) return { x: Math.round(layout.W / 2), w: Math.round(layout.W - 40), y: Math.round((layout.lanesTop + layout.H - layout.lanesBottom) / 2) }
  const gapL = layout.R * 1.18, gapR = layout.W - layout.side, want = 380
  if (gapR - gapL < want) return { x: Math.round((gapL + gapR) / 2), w: Math.max(180, Math.round(gapR - gapL - 24)), y: layout.H / 2 }
  return { x: Math.round(Math.min(gapR - want / 2, Math.max(gapL + want / 2, layout.W / 2))), w: want, y: layout.H / 2 }
})
const emptyX = computed(() => freeBox.value.x)
/** above the collapsed player sheet on phones */
// above the mini player on phones — or just above the screen edge while there's no music yet (no mini player)
const bottomY = computed(() => (layout.mobile ? (current.value || viewTracks.value.length ? layout.peek : 6) + layout.safeBottom : 0))
// only real file drags from outside show the overlay (dragging rows inside the playlist must not)
const isFileDrag = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].some(t => t === 'Files' || t === 'text/uri-list')
const onDragOver = (e: DragEvent) => { if (!isFileDrag(e)) return; e.preventDefault(); dropping.value = true }
const onDragLeave = (e: DragEvent) => { if (!e.relatedTarget) dropping.value = false }
const onDrop = async (e: DragEvent) => {
  dropping.value = false
  if (!e.dataTransfer || !isFileDrag(e)) return
  e.preventDefault()
  // folders (nested too) are walked for every audio file inside; collect synchronously, read async
  // a link dragged in from another tab
  if (![...e.dataTransfer.types].includes('Files')) {
    const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (t) void addLinks(t)
    return
  }
  const pending = collectDropped(e.dataTransfer)
  status.message = ''
  const files = await pending
  if (files.length) addFiles(files); else status.message = 'No audio files found in what you dropped.'
}

// ── first-run card on phones: what it says depends on how finding music went ──
const onboard = computed(() => {
  if (!isNative) return { title: 'Put a song on the record', text: 'Pick songs from your device or paste links. Everything is analysed right here — nothing is uploaded.', action: '', icon: Music, warn: false }
  switch (scanState.phase) {
    case 'scanning': return { title: 'Looking for music…', text: 'Reading this phone’s music library.', action: 'Looking for music…', icon: Smartphone, warn: false }
    case 'denied': return { title: 'Allow music access', text: 'Gramophone needs permission to see the songs on this phone. It only reads music — nothing leaves the device.', action: 'Allow access', icon: Smartphone, warn: true }
    case 'blocked': return { title: 'Music access is off', text: 'Android won’t ask again. Turn on “Music and audio” for Gramophone in its settings, then come back here.', action: 'Open app settings', icon: Settings2, warn: true }
    case 'empty': return { title: 'No songs found', text: 'Gramophone looked through this phone’s music library and found nothing. Songs you just copied can take a minute to show up — or pick files directly.', action: 'Try again', icon: RotateCcw, warn: true }
    case 'error': return { title: 'Couldn’t read your music', text: `Something went wrong: ${scanState.error}. Try again, or send a report so it can be fixed.`, action: 'Try again', icon: RotateCcw, warn: true }
    default: return { title: 'Your music, on a record', text: 'Gramophone finds the songs already on this phone and plays them on the deck. It only reads your music — nothing leaves the device.', action: 'Find music on this phone', icon: Smartphone, warn: false }
  }
})
function onboardPrimary() { if (scanState.phase === 'blocked') void openAppSettings(); else void scanPhone() }
const reportSent = ref('')
async function sendReport() { const r = await shareReport(); reportSent.value = r === 'copied' ? 'Report copied' : r === 'failed' ? 'Couldn’t share' : '' }
// back from Android's settings with access now allowed → look for music straight away
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !isNative) return
  if ((scanState.phase === 'blocked' || scanState.phase === 'denied') && (await musicAccess()).granted) void scanPhone()
})

/** ⌘V / Ctrl+V anywhere (outside text fields): audio files or links from the clipboard go into the playlist */
const onPaste = (e: ClipboardEvent) => {
  const el = e.target as HTMLElement
  if (ui.linkDialog || el.closest?.('input, textarea, [contenteditable="true"]')) return
  const cd = e.clipboardData
  if (!cd) return
  const files = [...cd.files]
  if (files.length) { e.preventDefault(); addFiles(files); return }
  const text = cd.getData('text/plain')
  if (text && extractUrls(text).length) { e.preventDefault(); void addLinks(text) }
}

onMounted(async () => {
  updateLayout(); addEventListener('resize', updateLayout)
  addEventListener('paste', onPaste)
  setupNativeChrome()
  // lock screen / notification / media keys
  setupMediaSession()
  addEventListener('keydown', onKey)
  startLoop()
  // quality tier changes → canvas size / pixel density follow
  watch(tier, updateLayout)
  onFrame(c => {
    // real frame times while music plays on screen → "auto" visual quality
    if (c.playing && !layout.covered && !document.hidden) sampleFrame(c.dt * 1000)
    // film grain: a new random offset every 2nd frame (~30 fps, like real film). It moves the layer with a transform,
    // which the compositor does on its own — no repaint of the full-screen noise every frame
    if (grain.value && (grainTick++ & 1) === 0) grain.value.style.transform = `translate3d(${-((Math.random() * 256) | 0)}px, ${-((Math.random() * 256) | 0)}px, 0)`
  })
  // your saved library + playlists come back where you left them; otherwise the deck starts empty
  status.loading = true; status.stage = 'restoring library'
  await restoreLibrary()
  if (!current.value) status.loading = false
  // Android app: pick up songs added to the phone since last time (only if music access was already given)
  if (isNative) void scanPhone({ quiet: true })
})
onBeforeUnmount(() => { removeEventListener('resize', updateLayout); removeEventListener('keydown', onKey); removeEventListener('paste', onPaste) })
</script>

<template>
  <div class="app" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <!-- installed app with the title bar hidden (window-controls-overlay): a strip to drag the window by -->
    <div class="titlebar" />
    <VinylStage />
    <NoteLanes v-if="settings.analysis" />
    <!-- analysis off: desktop shows the visualizer; phones dock the player there instead (Sidebar) -->
    <Visualizer v-else-if="current && !layout.mobile" />
    <div v-show="settings.grain && tier !== 'saver'" ref="grain" class="grain" :style="{ backgroundImage: `url(${grainUrl})` }" />
    <Sidebar />
    <LinkDialog />
    <SettingsDialog />

    <Transition name="fade">
      <div v-if="!current && !viewTracks.length && !status.loading" class="empty" :style="{ left: emptyX + 'px', top: freeBox.y + 'px', maxWidth: freeBox.w + 'px' }">
        <!-- phones: a small onboarding card — one clear primary action, two quiet alternatives -->
        <div v-if="layout.mobile" class="onboard">
          <span class="badge" :class="{ warn: onboard.warn }" aria-hidden="true">
            <component :is="onboard.warn ? RotateCcw : isNative ? Smartphone : Music" :size="26" :stroke-width="1.7" />
          </span>
          <h2>{{ onboard.title }}</h2>
          <p>{{ onboard.text }}</p>
          <template v-if="isNative">
            <button class="primary" :disabled="scanState.phase === 'scanning'" @click="onboardPrimary">
              <span v-if="scanState.phase === 'scanning'" class="spin" /><component :is="onboard.icon" v-else :size="18" :stroke-width="2" />{{ onboard.action }}
            </button>
          </template>
          <label v-else class="primary"><Music :size="18" :stroke-width="2" />Choose songs<input type="file" accept="audio/*" multiple @change="onPick"></label>
          <div class="alts">
            <label v-if="isNative" class="alt"><Music :size="16" :stroke-width="1.9" />Choose files<input type="file" accept="audio/*" multiple @change="onPick"></label>
            <button class="alt" @click="ui.linkDialog = true"><Link2 :size="16" :stroke-width="1.9" />Paste links</button>
          </div>
          <div class="tert">
            <button v-if="onboard.warn" @click="sendReport"><Bug :size="14" :stroke-width="2" />{{ reportSent || 'Send a report' }}</button>
            <button @click="ui.settings = true"><Settings2 :size="14" :stroke-width="2" />Settings</button>
          </div>
        </div>
        <span v-if="!layout.mobile" class="big">Drop music here</span>
        <span v-if="!layout.mobile" class="small">
          files or whole folders — or
          <label><u>choose files</u><input type="file" accept="audio/*" multiple @change="onPick"></label>
          ·
          <label><u>choose a folder</u><input type="file" webkitdirectory multiple @change="onPick"></label>
          ·
          <u class="as-link" role="button" tabindex="0" @click="ui.linkDialog = true" @keydown.enter="ui.linkDialog = true">paste links</u>
        </span>
      </div>
    </Transition>

    <footer class="credit" :style="{ left: emptyX + 'px', bottom: (layout.mobile ? bottomY + 12 : 18) + 'px' }">
      built with <span class="heart">&#x2665;&#xFE0E;</span> by Hex
      <span class="sep">·</span>
      <a href="https://github.com/RealMrHex/" target="_blank" rel="noopener noreferrer">GitHub</a>
      <span class="sep">·</span>
      <a href="https://t.me/MentionHex" target="_blank" rel="noopener noreferrer">Telegram</a>
    </footer>

    <Transition name="fade">
      <div v-if="status.message" class="msg" :style="{ left: `calc((100% - ${layout.side}px) / 2)`, bottom: (layout.mobile ? bottomY + 40 : 52) + 'px' }">{{ status.message }}</div>
    </Transition>
    <Transition name="fade">
      <div v-if="dropping" class="drop"><span>Drop files, folders or links to add them</span></div>
    </Transition>
  </div>
</template>

<style scoped>
.app { position: fixed; inset: 0; overflow: hidden; }
.titlebar { position: fixed; z-index: 8; top: env(titlebar-area-y, 0); left: env(titlebar-area-x, 0);
  width: env(titlebar-area-width, 0); height: env(titlebar-area-height, 0); app-region: drag; -webkit-app-region: drag; }
.grain { position: fixed; left: 0; top: 0; right: -256px; bottom: -256px; pointer-events: none; z-index: 8; opacity: .055;
  background-repeat: repeat; background-size: 256px 256px; will-change: transform; }
.msg { position: fixed; left: 50%; bottom: 52px; transform: translateX(-50%); padding: 8px 14px; border-radius: 99px; z-index: 6;
  background: rgba(20, 18, 20, .8); border: 1px solid rgba(255, 255, 255, .06); color: #a3a3ab; font-size: 12.5px; pointer-events: none; }
.drop { position: fixed; inset: 0; z-index: 9; display: grid; place-items: center; background: rgba(5, 5, 6, .55); backdrop-filter: blur(3px); }
.drop span { padding: 18px 26px; border-radius: 16px; border: 1.5px dashed rgba(255, 122, 89, .6); color: #ffb39f; font-size: 15px; background: rgba(20, 12, 12, .7); }
.empty { position: fixed; top: 50%; transform: translate(-50%, -50%); z-index: 5; display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 28px 12px; text-align: center; box-sizing: border-box; }
.empty .small { line-height: 1.7; }
.empty button.pick { font: inherit; color: inherit; cursor: pointer; white-space: nowrap; }
.empty .pick { margin-top: 4px; padding: 10px 20px; border-radius: 99px; background: rgba(255, 122, 89, .1); border: 1px solid rgba(255, 179, 159, .25); }
.empty .pick u { border: 0; font-size: 14px; }
.empty label, .empty .as-link { cursor: pointer; }
.empty .pick-link { all: unset; cursor: pointer; font-size: 13px; color: #8b858c; padding: 6px 10px; }
.empty input { display: none; }
/* phones: onboarding card */
.onboard { display: flex; flex-direction: column; align-items: center; text-align: center; width: min(340px, calc(100vw - 48px)); }
.onboard .badge { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; color: #ffb39f;
  background: radial-gradient(circle at 50% 35%, rgba(255, 122, 89, .22), rgba(255, 122, 89, .06));
  box-shadow: 0 0 0 1px rgba(255, 164, 140, .18), 0 0 40px rgba(255, 122, 89, .18); }
.onboard h2 { margin: 18px 0 0; font-size: 22px; font-weight: 600; letter-spacing: -.01em; color: #f4eef0; }
.onboard p { margin: 10px 0 0; font-size: 14px; line-height: 1.55; color: #948d92; }
.onboard .primary, .onboard .alt { all: unset; box-sizing: border-box; display: inline-flex; white-space: nowrap; align-items: center; justify-content: center; gap: 9px; cursor: pointer;
  -webkit-tap-highlight-color: transparent; transition: transform .12s, background .2s; }
.onboard .primary { margin-top: 24px; width: 100%; height: 52px; border-radius: 16px; font-size: 15.5px; font-weight: 600; color: #1d1316;
  background: #f4e7df; box-shadow: 0 12px 28px rgba(0, 0, 0, .45), 0 0 0 1px rgba(255, 255, 255, .06) inset; }
.onboard .primary:active, .onboard .alt:active { transform: scale(.97); }
.onboard .alts { display: flex; gap: 10px; width: 100%; margin-top: 10px; }
.onboard .alt { flex: 1; height: 46px; border-radius: 14px; font-size: 14px; font-weight: 500; color: #e2dadd;
  background: rgba(255, 255, 255, .05); border: 1px solid rgba(255, 255, 255, .08); }
.onboard .alt svg { color: #ffa48c; }
.onboard .badge.warn { color: #ffc9a8; }
.onboard .primary:disabled { opacity: .7; pointer-events: none; }
.onboard .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(29, 19, 22, .25); border-top-color: #1d1316; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.onboard .tert { display: flex; gap: 6px; justify-content: center; margin-top: 14px; }
.onboard .tert button { all: unset; display: inline-flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 10px; font-size: 13px; color: #8f888d; cursor: pointer; }
.onboard .tert button:active { background: rgba(255, 255, 255, .06); }
.onboard .primary:focus-visible, .onboard .alt:focus-visible { outline: 2px solid rgba(255, 155, 128, .7); outline-offset: 3px; }
.empty .big { font-size: clamp(20px, 2.4vw, 30px); font-weight: 600; color: #ece6e8; letter-spacing: -.01em; }
.empty .small { font-size: 13.5px; color: #8b858c; }
.empty u { color: #ffb39f; text-decoration: none; border-bottom: 1px solid rgba(255, 179, 159, .4); }
.empty label:hover u { border-bottom-color: #ffb39f; }
.credit { position: fixed; bottom: 18px; transform: translateX(-50%); z-index: 5; white-space: nowrap;
  font-size: 11.5px; letter-spacing: .02em; color: #57525a; }
.credit a { color: #77717a; text-decoration: none; transition: color .2s; }
.credit a:hover { color: #e9b3a3; }
.credit .heart { color: #6f6970; font-family: ui-sans-serif, system-ui, sans-serif; font-variant-emoji: text; }
.credit .sep { margin: 0 6px; color: #3f3a41; }
.fade-enter-active, .fade-leave-active { transition: opacity .3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
