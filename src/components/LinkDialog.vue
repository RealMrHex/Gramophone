<script setup lang="ts">
/** "Add from links": paste one or many direct audio links (or .m3u / .pls playlist links). */
import { computed, nextTick, ref, watch } from 'vue'
import { ClipboardPaste, Link2, X } from 'lucide-vue-next'
import { addLinks, ui } from '../composables/library'
import { extractUrls, urlKey } from '../composables/links'
import { layout } from '../composables/layout'

const text = ref('')
const box = ref<HTMLTextAreaElement>()
const busy = ref(false)
const count = computed(() => new Set(extractUrls(text.value).map(urlKey)).size)
const canRead = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText
const pasteNote = ref('')

watch(() => ui.linkDialog, async o => {
  if (!o) return
  text.value = ''; pasteNote.value = ''
  await nextTick()
  box.value?.focus()
})
function close() { if (!busy.value) ui.linkDialog = false }
async function pasteClip() {
  try {
    const t = await navigator.clipboard.readText()
    if (!t.trim()) { pasteNote.value = 'The clipboard is empty.'; return }
    text.value = text.value.trim() ? text.value.trimEnd() + '\n' + t : t
    pasteNote.value = ''
  } catch { pasteNote.value = 'Clipboard access was blocked — paste with ⌘V / Ctrl+V instead.' }
}
async function submit() {
  if (!count.value || busy.value) return
  busy.value = true
  try { await addLinks(text.value) } finally { busy.value = false }
  ui.linkDialog = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); close() }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="ld">
      <div v-if="ui.linkDialog" class="ld-wrap" :class="{ mobile: layout.mobile }" @pointerdown.self="close" @keydown="onKey">
        <div class="ld" role="dialog" aria-modal="true" aria-labelledby="ld-title">
          <header>
            <span class="badge"><Link2 :size="18" :stroke-width="2" /></span>
            <div>
              <h2 id="ld-title">Add from links</h2>
              <p>Direct links to audio files — mp3, m4a, ogg, flac, wav — or an .m3u / .pls playlist. One or dozens.</p>
            </div>
            <button class="x" aria-label="Close" @click="close"><X :size="18" :stroke-width="2" /></button>
          </header>

          <textarea
            ref="box" v-model="text" spellcheck="false" autocapitalize="off" autocomplete="off"
            placeholder="https://example.com/music/song.mp3&#10;https://example.com/another-track.m4a"
            aria-label="Links to add"
          />
          <div class="meta">
            <span :class="{ on: count }">{{ count ? `${count} link${count === 1 ? '' : 's'} found` : 'Paste or type links, one per line' }}</span>
            <span v-if="pasteNote" class="warn">{{ pasteNote }}</span>
          </div>
          <p class="fine">
            Links play with the full visualizer when the host allows other sites to read the file. Ones that can’t be
            played are marked and skipped. Duplicates are ignored.
          </p>

          <footer>
            <button v-if="canRead" class="ghost" @click="pasteClip"><ClipboardPaste :size="16" :stroke-width="1.9" /> Paste</button>
            <span class="grow" />
            <button class="ghost" @click="close">Cancel</button>
            <button class="primary" :disabled="!count || busy" @click="submit">
              {{ busy ? 'Adding…' : count > 1 ? `Add ${count} links` : 'Add link' }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ld-wrap { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 20px;
  background: rgba(5, 4, 5, .55); backdrop-filter: blur(8px); }
.ld { width: min(520px, 100%); box-sizing: border-box; padding: 20px; border-radius: 18px;
  background: linear-gradient(180deg, rgba(34, 29, 32, .98), rgba(20, 17, 19, .98)); border: 1px solid rgba(255, 255, 255, .08);
  box-shadow: 0 30px 70px rgba(0, 0, 0, .6); color: #e6e0e2; font: 14px ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif; }
header { display: flex; gap: 12px; align-items: flex-start; }
.badge { flex: none; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; color: #ffb39f; background: rgba(255, 122, 89, .12); }
h2 { margin: 1px 0 4px; font-size: 16px; font-weight: 600; color: #f6f3f4; }
header p { margin: 0; font-size: 12.5px; line-height: 1.5; color: #948d92; }
.x { all: unset; flex: none; width: 32px; height: 32px; margin: -4px -6px 0 auto; display: grid; place-items: center; border-radius: 50%; color: #8f888f; cursor: pointer; }
.x:hover { background: rgba(255, 255, 255, .06); color: #fff; }
textarea { display: block; width: 100%; box-sizing: border-box; height: 150px; margin-top: 16px; padding: 12px 14px; resize: vertical;
  border-radius: 12px; border: 1px solid rgba(255, 255, 255, .09); background: rgba(0, 0, 0, .28); color: #f1ecee; outline: none;
  font: 13px/1.6 var(--mono); white-space: pre; overflow-wrap: normal; overflow-x: auto; }
textarea:focus { border-color: rgba(255, 155, 128, .5); box-shadow: 0 0 0 3px rgba(255, 122, 89, .1); }
textarea::placeholder { color: #5d585e; }
/* the app's thin scrollbars (both directions — long links scroll sideways) */
textarea { scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .16) transparent; }
textarea::-webkit-scrollbar { width: 10px; height: 10px; }
textarea::-webkit-scrollbar-track, textarea::-webkit-scrollbar-corner { background: transparent; }
textarea::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .13); border-radius: 10px; border: 3px solid transparent; background-clip: padding-box; }
textarea:hover::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, .22); }
textarea::-webkit-resizer { background: transparent; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-size: 12px; color: #77717a; }
.meta .on { color: #f0b3a1; }
.meta .warn { color: #ff8c75; }
.fine { margin: 10px 0 0; font-size: 11.5px; line-height: 1.5; color: #6f6970; }
footer { display: flex; align-items: center; gap: 8px; margin-top: 18px; }
.grow { flex: 1; }
footer button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0 14px; border-radius: 10px; cursor: pointer; font-size: 13.5px; font-weight: 500; }
footer button:focus-visible { outline: 2px solid rgba(255, 155, 128, .6); outline-offset: 2px; }
.ghost { color: #cfc8cb; }
.ghost:hover { background: rgba(255, 255, 255, .06); }
.primary { color: #1d1316; background: #f4e7df; font-weight: 600; }
.primary:hover { background: #fff; }
.primary:disabled { opacity: .35; pointer-events: none; }
/* phones: a sheet from the bottom, bigger targets, 16px text so iOS doesn't zoom */
.ld-wrap.mobile { place-items: end stretch; padding: 0; }
.mobile .ld { width: 100%; border-radius: 22px 22px 0 0; padding: 20px 18px calc(18px + env(safe-area-inset-bottom, 0px)); }
.mobile textarea { font-size: 16px; height: 130px; }
.mobile footer button { height: 44px; }
.ld-enter-active, .ld-leave-active { transition: opacity .22s; }
.ld-enter-active .ld, .ld-leave-active .ld { transition: transform .26s cubic-bezier(.2, .85, .25, 1); }
.ld-enter-from, .ld-leave-to { opacity: 0; }
.ld-enter-from .ld, .ld-leave-to .ld { transform: translateY(12px) scale(.98); }
.mobile.ld-enter-from .ld, .mobile.ld-leave-to .ld { transform: translateY(100%); }
</style>
