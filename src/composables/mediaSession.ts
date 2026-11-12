/**
 * Now-playing outside the app.
 *
 *  - Android app: the MediaControls plugin (MediaHub.java) → notification, lock-screen player, quick-settings media
 *    card, headset / Bluetooth buttons
 *  - browsers + installed PWA: the standard Media Session API → the OS media keys, Chrome's media hub, lock screens
 *
 * Both get the title, artist, a cover (the song's art, or the record Gramophone pressed for it), the position, and
 * play / pause / next / previous / seek, which come back here and drive the normal player.
 */
import { watch } from 'vue'
import { registerPlugin } from '@capacitor/core'
import { audio, pause, play, playing, seek } from './player'
import { current, hasNext, lib, next, prev, type Track } from './library'
import { vinylTex } from './store'
import { isNative } from './native'

interface Update {
  title: string; artist: string; album: string; artwork?: string
  duration: number; position: number; playing: boolean; canPrev: boolean; canNext: boolean
}
interface MediaControlsPlugin {
  update(u: Update): Promise<void>
  clear(): Promise<void>
  addListener(ev: 'action', cb: (e: { action: string; position?: number }) => void): Promise<{ remove: () => void }>
}
const Native = registerPlugin<MediaControlsPlugin>('MediaControls')
const web = !isNative && typeof navigator !== 'undefined' && 'mediaSession' in navigator

// ── artwork: a 512 px square, made once per track (cover art, else the record texture) ──
let art: { key: string; jpeg: string; url: string } | null = null
function square(src: CanvasImageSource, w: number, h: number) {
  const c = document.createElement('canvas'); c.width = c.height = 512
  const g = c.getContext('2d')!
  const s = Math.min(w, h)
  g.fillStyle = '#0c0a0b'; g.fillRect(0, 0, 512, 512)
  g.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 512, 512)
  return c.toDataURL('image/jpeg', 0.86)
}
async function artworkFor(t: Track): Promise<typeof art> {
  const tex = vinylTex.value
  const key = `${t.id}:${t.coverUrl ? 'cover' : tex ? 'record' : 'none'}`
  if (art?.key === key) return art
  let url: string | null = null
  try {
    if (t.coverUrl) {
      const img = new Image(); img.src = t.coverUrl
      await img.decode()
      url = square(img, img.naturalWidth, img.naturalHeight)
    } else if (tex) url = square(tex, tex.width, tex.height)
  } catch { url = null }
  art = url ? { key, jpeg: url.split(',')[1], url } : null
  return art
}

// ── push state out (coalesced: several changes in one tick → one update) ──
let queued = false, sentArtKey = ''
function schedule() {
  if (queued) return
  queued = true
  queueMicrotask(() => { queued = false; void push() })
}
async function push() {
  const t = current.value
  if (!t) {
    if (isNative) void Native.clear().catch(() => {})
    if (web) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none' }
    sentArtKey = ''
    return
  }
  const a = await artworkFor(t)
  const duration = isFinite(audio.duration) ? audio.duration : t.duration ?? 0
  const position = Math.min(duration || Infinity, audio.currentTime || 0)
  const isPlaying = playing.value
  if (isNative) {
    const u: Update = {
      title: t.title, artist: t.artist || 'Unknown artist', album: 'Gramophone',
      duration, position, playing: isPlaying, canPrev: true, canNext: hasNext.value,
    }
    // the cover only crosses the bridge when it changed
    if (a && a.key !== sentArtKey) { u.artwork = a.jpeg; sentArtKey = a.key }
    void Native.update(u).catch(() => {})
  }
  if (web) {
    const ms = navigator.mediaSession
    const meta = ms.metadata
    if (!meta || meta.title !== t.title || meta.artist !== (t.artist || '') || (a && a.key !== sentArtKey)) {
      ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: 'Gramophone', artwork: a ? [{ src: a.url, sizes: '512x512', type: 'image/jpeg' }] : [] })
      if (a) sentArtKey = a.key
    }
    ms.playbackState = isPlaying ? 'playing' : 'paused'
    if (duration > 0) { try { ms.setPositionState({ duration, position, playbackRate: isPlaying ? 1 : 1 }) } catch { /* bad values mid-load */ } }
  }
}

// ── actions from outside ──
function act(action: string, position?: number) {
  if (!current.value) return
  if (action === 'play') play()
  else if (action === 'pause') pause()
  else if (action === 'toggle') { if (playing.value) pause(); else play() }
  else if (action === 'next') void next()
  else if (action === 'prev') void prev()
  else if (action === 'seek' && position != null) seek(position, { smooth: true })
}

let started = false
export function setupMediaSession() {
  if (started || (!isNative && !web)) return
  started = true
  watch([() => current.value?.id, () => current.value?.title, () => current.value?.coverUrl, playing, hasNext, vinylTex, () => lib.repeat], schedule)
  for (const ev of ['durationchange', 'seeked', 'play', 'pause', 'ratechange']) audio.addEventListener(ev, schedule)
  if (isNative) void Native.addListener('action', e => act(e.action, e.position))
  if (web) {
    const ms = navigator.mediaSession
    const set = (a: MediaSessionAction, fn: MediaSessionActionHandler) => { try { ms.setActionHandler(a, fn) } catch { /* not supported here */ } }
    set('play', () => act('play'))
    set('pause', () => act('pause'))
    set('nexttrack', () => act('next'))
    set('previoustrack', () => act('prev'))
    set('seekto', d => act('seek', d.seekTime ?? undefined))
    set('seekbackward', d => act('seek', Math.max(0, audio.currentTime - (d.seekOffset ?? 10))))
    set('seekforward', d => act('seek', audio.currentTime + (d.seekOffset ?? 10)))
  }
  schedule()
}
