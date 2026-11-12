<script setup lang="ts">
/**
 * Small anchored menu, teleported to <body> so scroll containers never clip it. Opens below the anchor
 * (flips above when there's no room), aligns to the anchor's left or right edge, closes on outside
 * click, Escape, scroll or resize.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ anchor: HTMLElement | null; open: boolean; align?: 'left' | 'right'; width?: number }>(), {
  align: 'left', width: 220,
})
const emit = defineEmits<{ close: [] }>()
const el = ref<HTMLElement>()
const pos = ref({ top: 0, left: 0 })

function place() {
  if (!props.anchor || !el.value) return
  const a = props.anchor.getBoundingClientRect(), m = el.value.getBoundingClientRect()
  let top = a.bottom + 6
  if (top + m.height > innerHeight - 8) top = Math.max(8, a.top - 6 - m.height)
  let left = props.align === 'right' ? a.right - props.width : a.left
  left = Math.min(innerWidth - props.width - 8, Math.max(8, left))
  pos.value = { top, left }
}
const onDoc = (e: PointerEvent) => {
  const t = e.target as Node
  if (el.value?.contains(t) || props.anchor?.contains(t)) return
  emit('close')
}
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') emit('close') }
const onAway = () => emit('close')
function bind(on: boolean) {
  const f = on ? addEventListener : removeEventListener
  f('pointerdown', onDoc as EventListener, true); f('keydown', onKey as EventListener); f('resize', onAway); f('scroll', onAway, true)
}
watch(() => props.open, async o => { bind(o); if (o) { await nextTick(); place() } })
onBeforeUnmount(() => bind(false))
</script>

<template>
  <Teleport to="body">
    <Transition name="gm-pop">
      <div v-if="open" ref="el" class="gm-menu" :style="{ top: pos.top + 'px', left: pos.left + 'px', width: width + 'px' }">
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.gm-menu {
  position: fixed; z-index: 50; padding: 6px; border-radius: 12px; box-sizing: border-box;
  background: rgba(30, 26, 29, .98); border: 1px solid rgba(255, 255, 255, .08);
  box-shadow: 0 20px 44px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .3);
  font: 13px ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif; color: #e2dcde;
}
.gm-menu .gm-item {
  all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 10px; border-radius: 8px; cursor: pointer; line-height: 1.2;
}
.gm-menu .gm-item:hover, .gm-menu .gm-item:focus-visible { background: rgba(255, 255, 255, .06); }
.gm-menu .gm-item:disabled { opacity: .35; pointer-events: none; }
.gm-menu .gm-item svg { width: 16px; height: 16px; flex: none; color: #a39ca2; }
.gm-menu .gm-item .gm-grow { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gm-menu .gm-item .gm-note { font: 11px ui-monospace, Menlo, monospace; color: #6f6970; }
.gm-menu .gm-item.on { color: #ffc2b2; }
.gm-menu .gm-item.on svg { color: #ffa48c; }
.gm-menu .gm-item.danger { color: #ff8c75; }
.gm-menu .gm-item.danger svg { color: #ff8c75; }
.gm-menu .gm-item input { display: none; }
.gm-menu .gm-label { padding: 8px 10px 4px; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #6f6970; }
.gm-menu .gm-sep { height: 1px; margin: 5px 4px; background: rgba(255, 255, 255, .06); }
.gm-menu .gm-input {
  all: unset; box-sizing: border-box; width: 100%; padding: 7px 10px; border-radius: 8px; color: #fff;
  background: rgba(0, 0, 0, .3); border: 1px solid rgba(255, 155, 128, .4);
}
.gm-pop-enter-active, .gm-pop-leave-active { transition: opacity .14s, transform .14s; }
.gm-pop-enter-from, .gm-pop-leave-to { opacity: 0; transform: translateY(-4px) scale(.98); }
</style>
