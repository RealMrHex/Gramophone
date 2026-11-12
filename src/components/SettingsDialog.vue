<script setup lang="ts">
/**
 * Settings. Sections are plain blocks so new ones slot in easily:
 *  Look & feel (visual quality, film grain) · Listening (analysis) · Music on this phone (Android) · Help (report) · About
 */
import { computed, ref, watch } from 'vue'
import { Bug, ClipboardCopy, Settings2, Smartphone, X } from 'lucide-vue-next'
import { applyAnalysisSetting, scanPhone, scanState, ui } from '../composables/library'
import { layout } from '../composables/layout'
import { isNative, musicAccess, openAppSettings } from '../composables/native'
import { perf, settings, tier, tierLabel, type Quality } from '../composables/settings'
import { copyReport, shareReport } from '../composables/diagnostics'
import { lastScan } from '../composables/diagLog'

declare const __APP_VERSION__: string
const version = __APP_VERSION__

const QUALITIES: { v: Quality; label: string }[] = [
  { v: 'auto', label: 'Auto' }, { v: 'high', label: 'High' }, { v: 'balanced', label: 'Balanced' }, { v: 'saver', label: 'Saver' },
]
const qualityNote = computed(() => {
  if (settings.quality === 'auto') return `Picks what this device can play smoothly — now ${tierLabel[tier.value]}${perf.frameMs ? ` (frames ≈ ${perf.frameMs} ms)` : ''}.`
  return { high: 'Full detail: sharpest record, motion blur, soft focus on the melody lines.',
    balanced: 'A bit lighter on the graphics — smooth on most phones.',
    saver: 'Lightest: 30 fps record, no blur or grain, fewer melody lines. Easiest on the battery.' }[settings.quality]
})

const access = ref('')
watch(() => ui.settings, async o => { if (o && isNative) access.value = (await musicAccess()).state })
const accessLabel = computed(() => ({ granted: 'Allowed', denied: 'Turned off', prompt: 'Not asked yet', 'prompt-with-rationale': 'Not allowed' } as Record<string, string>)[access.value] ?? '—')
const scanLabel = computed(() => {
  if (scanState.phase === 'scanning') return 'Looking for music…'
  if (!lastScan.at) return 'Not scanned yet'
  const mins = Math.round((Date.now() - Date.parse(lastScan.at)) / 60000)
  const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`
  return lastScan.outcome === 'ok' ? `${lastScan.found} songs · scanned ${when}` : lastScan.outcome === 'empty' ? `No songs found · ${when}` : `Last scan: ${lastScan.outcome}`
})
async function rescan() { await scanPhone(); access.value = (await musicAccess()).state }

const sent = ref('')
async function share() { const r = await shareReport(); sent.value = r === 'shared' ? 'Report ready to send' : r === 'copied' ? 'Report copied — paste it in a message' : 'Couldn’t share the report' }
async function copy() { const r = await copyReport(); sent.value = r === 'copied' ? 'Report copied — paste it in a message' : 'Couldn’t copy the report' }

function toggleAnalysis() { settings.analysis = !settings.analysis; void applyAnalysisSetting() }
const close = () => { ui.settings = false; sent.value = '' }
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
</script>

<template>
  <Teleport to="body">
    <Transition name="sd">
      <div v-if="ui.settings" class="sd-wrap" :class="{ mobile: layout.mobile }" @pointerdown.self="close" @keydown="onKey">
        <div class="sd" role="dialog" aria-modal="true" aria-labelledby="sd-title">
          <header>
            <span class="badge"><Settings2 :size="18" :stroke-width="2" /></span>
            <h2 id="sd-title">Settings</h2>
            <button class="x" aria-label="Close settings" @click="close"><X :size="19" :stroke-width="2" /></button>
          </header>

          <div class="scroll">
            <section>
              <h3>Look &amp; feel</h3>
              <div class="item col">
                <div class="lbl"><b>Visual quality</b><small>{{ qualityNote }}</small></div>
                <div class="seg" role="radiogroup" aria-label="Visual quality">
                  <button v-for="q in QUALITIES" :key="q.v" role="radio" :aria-checked="settings.quality === q.v" :class="{ on: settings.quality === q.v }" @click="settings.quality = q.v">{{ q.label }}</button>
                </div>
              </div>
              <div class="item">
                <div class="lbl"><b>Film grain</b><small>{{ tier === 'saver' ? 'Paused while Battery saver is on.' : 'The soft film texture over everything.' }}</small></div>
                <button class="sw" role="switch" :aria-checked="settings.grain" aria-label="Film grain" :class="{ on: settings.grain }" @click="settings.grain = !settings.grain"><i /></button>
              </div>
            </section>

            <section>
              <h3>Listening</h3>
              <div class="item">
                <div class="lbl">
                  <b>Melody &amp; beat analysis</b>
                  <small>Reads each song's melody, hooks, key and tempo. Turn it off on slower phones — songs start faster, the battery lasts longer, and you get a live visualizer instead of the notes.</small>
                </div>
                <button class="sw" role="switch" :aria-checked="settings.analysis" aria-label="Melody and beat analysis" :class="{ on: settings.analysis }" @click="toggleAnalysis"><i /></button>
              </div>
            </section>

            <section v-if="isNative">
              <h3>Music on this phone</h3>
              <div class="item col">
                <div class="lbl"><b>{{ scanLabel }}</b><small>Music access: {{ accessLabel }}</small></div>
                <div class="btns">
                  <button class="btn" :disabled="scanState.phase === 'scanning'" @click="rescan"><Smartphone :size="16" :stroke-width="1.9" />Scan again</button>
                  <button class="btn ghost" @click="openAppSettings">App permissions</button>
                </div>
              </div>
            </section>

            <section>
              <h3>Help</h3>
              <div class="item col">
                <div class="lbl"><b>Something not working?</b><small>Send a diagnostics report: device model, app settings, library counts and recent errors — never song names or files.</small></div>
                <div class="btns">
                  <button class="btn" @click="share"><Bug :size="16" :stroke-width="1.9" />Send a report</button>
                  <button class="btn ghost" @click="copy"><ClipboardCopy :size="16" :stroke-width="1.9" />Copy</button>
                </div>
                <p v-if="sent" class="sent" role="status">{{ sent }}</p>
              </div>
            </section>

            <section class="about">
              <p><b>Gramophone</b> {{ version }}</p>
              <p>built with <span class="heart">&#x2665;&#xFE0E;</span> by Hex · <a href="https://github.com/RealMrHex/" target="_blank" rel="noopener">GitHub</a> · <a href="https://t.me/MentionHex" target="_blank" rel="noopener">Telegram</a></p>
              <p class="lic">Licensed CC BY 4.0</p>
            </section>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sd-wrap { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 20px;
  background: rgba(5, 4, 5, .55); backdrop-filter: blur(8px); }
.sd { width: min(480px, 100%); max-height: min(720px, calc(100vh - 40px)); display: flex; flex-direction: column; box-sizing: border-box;
  border-radius: 20px; background: linear-gradient(180deg, rgba(34, 29, 32, .98), rgba(20, 17, 19, .98)); border: 1px solid rgba(255, 255, 255, .08);
  box-shadow: 0 30px 70px rgba(0, 0, 0, .6); color: #e6e0e2; font: 14px ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif; overflow: hidden; }
header { display: flex; align-items: center; gap: 12px; padding: 18px 18px 14px 20px; border-bottom: 1px solid rgba(255, 255, 255, .06); }
.badge { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; color: #ffb39f; background: rgba(255, 122, 89, .12); }
h2 { flex: 1; margin: 0; font-size: 17px; font-weight: 600; color: #f6f3f4; }
.x { all: unset; width: 36px; height: 36px; display: grid; place-items: center; border-radius: 50%; color: #8f888f; cursor: pointer; }
.x:hover { background: rgba(255, 255, 255, .06); color: #fff; }
.scroll { overflow-y: auto; overscroll-behavior: contain; padding: 6px 20px 20px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .14) transparent; }
section { padding: 14px 0 6px; }
section + section { border-top: 1px solid rgba(255, 255, 255, .05); }
h3 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #8b7f84; }
.item { display: flex; align-items: center; gap: 16px; padding: 10px 0; }
.item.col { flex-direction: column; align-items: stretch; gap: 12px; }
.lbl { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.lbl b { font-size: 14.5px; font-weight: 600; color: #f1ecee; }
.lbl small { font-size: 12.5px; line-height: 1.5; color: #8f888d; }
/* switch */
.sw { all: unset; flex: none; position: relative; width: 46px; height: 28px; border-radius: 99px; background: rgba(255, 255, 255, .12); cursor: pointer; transition: background .2s; }
.sw i { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #f4eef0; box-shadow: 0 2px 6px rgba(0, 0, 0, .4); transition: transform .22s cubic-bezier(.2, .85, .25, 1); }
.sw.on { background: #ff7a59; }
.sw.on i { transform: translateX(18px); }
.sw:focus-visible, .seg button:focus-visible, .btn:focus-visible { outline: 2px solid rgba(255, 155, 128, .7); outline-offset: 2px; }
/* segmented */
.seg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 4px; border-radius: 12px; background: rgba(0, 0, 0, .28); border: 1px solid rgba(255, 255, 255, .06); }
.seg button { all: unset; text-align: center; padding: 9px 4px; border-radius: 9px; font-size: 13px; font-weight: 600; color: #a39ba0; cursor: pointer; transition: background .15s, color .15s; }
.seg button.on { background: #f4e7df; color: #1d1316; }
.btns { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { all: unset; display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 11px; cursor: pointer; font-size: 13.5px; font-weight: 600;
  color: #1d1316; background: #f4e7df; }
.btn.ghost { color: #e2dadd; background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .08); }
.btn:disabled { opacity: .45; pointer-events: none; }
.sent { margin: 0; font-size: 12.5px; color: #f0b3a1; }
.about { text-align: center; padding-top: 18px; }
.about p { margin: 0 0 6px; font-size: 12.5px; color: #8f888d; }
.about b { color: #e6e0e2; }
.about a { color: #c9a99c; text-decoration: none; }
.about .heart { font-family: ui-sans-serif, system-ui, sans-serif; }
.about .lic { color: #6f676a; }
/* phones: a sheet from the bottom with big targets */
.sd-wrap.mobile { place-items: end stretch; padding: 0; }
.mobile .sd { width: 100%; max-height: calc(100vh - 40px); border-radius: 22px 22px 0 0; }
.mobile .scroll { padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px)); }
.mobile .btn { height: 44px; }
.sd-enter-active, .sd-leave-active { transition: opacity .22s; }
.sd-enter-active .sd, .sd-leave-active .sd { transition: transform .28s cubic-bezier(.2, .85, .25, 1); }
.sd-enter-from, .sd-leave-to { opacity: 0; }
.sd-enter-from .sd, .sd-leave-to .sd { transform: translateY(12px) scale(.98); }
.mobile.sd-enter-from .sd, .mobile.sd-leave-to .sd { transform: translateY(100%); }
</style>
