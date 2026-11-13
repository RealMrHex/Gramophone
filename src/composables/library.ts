/**
 * Library + playlists + playback order.
 *
 *  - tracks live once in a library (by id); playlists are ordered lists of track ids
 *  - one playlist is *viewed* in the sidebar, one is *playing* (they can differ)
 *  - playback order follows the playing playlist, optionally shuffled; repeat off / all / one
 *  - the previous and next tracks are decoded + analysed in the background (prefetch cache),
 *    so skipping is instant
 *  - everything (tracks, playlists, position, modes, volume) persists in IndexedDB
 */
import { computed, markRaw, reactive, watch } from 'vue'
import { analyze, decodeToMono } from '../audio/analyze'
import { readTags } from '../audio/cover'
import { NAMES } from '../audio/music'
import { lookFromCover, type RecordLook } from '../render/palette'
import { buildVinyl } from '../render/vinyl'
import { hashStr } from '../render/rand'
import type { Analysis } from '../types'
import { analysis, look, meta, resetActive, vinylTex } from './store'
import { audio, fadeOut, loadSource, play, playing, seek, setPcm, setVolume, unloadSource } from './player'
import { deleteAudio, deleteTrack, loadAll, loadAudio, saveAudio, saveState, saveTrack, saveTracks, whenStorageBlocked, type StoredState, type StoredTrack } from './persist'
whenStorageBlocked(() => { status.stage = 'close other Gramophone tabs to update'; status.message = 'Gramophone was updated — close its other open tabs to finish.' })
import { logEvent, lastScan } from './diagLog'
import { AUDIO_RE } from './files'
import { settings } from './settings'
import { deviceArtwork, deviceSrc, isDeviceUrl, isNative, musicAccess, requestMusicAccess, scanDevice } from './native'
import { checkAudioResponse, download, expandPlaylist, extractUrls, fetchSoon, fileKey, hostOf, isOffline, isPlaylistUrl, LinkError, reasonOf, titleFromUrl, urlKey } from './links'

export interface Track {
  id: number
  /** local audio; for link tracks only while it's on (or next to) the deck */
  blob: Blob | null
  /** direct link this track streams from */
  url: string | null
  /** duplicate-detection key (content fingerprint / normalised URL) */
  key: string | null
  /** set when the track couldn't be played: it's skipped and not retried until the user asks */
  failed: string | null
  /** link track whose audio is kept on the device (plays offline) */
  cached?: boolean
  title: string
  artist: string
  cover: Blob | null
  coverUrl: string | null
  duration: number | null
}
export interface Playlist { id: number; name: string; trackIds: number[] }
export type Repeat = 'off' | 'all' | 'one'

export const lib = reactive({
  tracks: {} as Record<number, Track>,
  playlists: [] as Playlist[],
  viewId: 0,
  playingId: 0,
  currentId: null as number | null,
  shuffle: false,
  repeat: 'off' as Repeat,
  volume: 1,
  muted: false,
})
export const status = reactive({ loading: false, progress: 0, stage: '', message: '' })
/** UI flags shared between components */
export const ui = reactive({ linkDialog: false, settings: false })
// messages fade out on their own
let msgTimer = 0
watch(() => status.message, m => { clearTimeout(msgTimer); if (m) msgTimer = window.setTimeout(() => { if (status.message === m) status.message = '' }, 5200) })

const plById = (id: number) => lib.playlists.find(p => p.id === id)
export const viewed = computed(() => plById(lib.viewId) ?? null)
export const viewTracks = computed(() => (viewed.value?.trackIds ?? []).map(id => lib.tracks[id]).filter(Boolean))
export const current = computed(() => (lib.currentId != null ? lib.tracks[lib.currentId] ?? null : null))

let nextTrackId = 1, nextPlaylistId = 1, loadToken = 0
const baseName = (n: string) => n.replace(/\.[^.]+$/, '')
function hueFor(title: string, key?: string) {
  if (key) { const k = NAMES.indexOf(key.split(' ')[0]); if (k >= 0) return (310 + k * 6) % 360 }
  return hashStr(title) % 360
}
function probeDuration(src: Blob | string): Promise<number | null> {
  return new Promise(res => {
    const a = new Audio(), own = typeof src !== 'string', url = own ? URL.createObjectURL(src) : src
    const done = (d: number | null) => { if (own) URL.revokeObjectURL(url); a.removeAttribute('src'); res(d) }
    const timer = setTimeout(() => done(null), 15000)
    a.preload = 'metadata'
    a.onloadedmetadata = () => { clearTimeout(timer); done(isFinite(a.duration) ? a.duration : null) }
    a.onerror = () => { clearTimeout(timer); done(null) }
    a.src = url
  })
}

// ───────────────────────────── play order (shuffle / repeat) ─────────────────────────────
/** track ids of the playing playlist in the order they'll play */
let order: number[] = []
/** links that couldn't stream because there's no network: skipped (not flagged) until the connection is back */
const unreachable = reactive(new Set<number>())
addEventListener('online', () => unreachable.clear())
function rebuildOrder() {
  const ids = [...(plById(lib.playingId)?.trackIds ?? [])]
  if (!lib.shuffle) { order = ids; return }
  // Fisher–Yates; the current track goes first so the shuffle continues from "now"
  for (let i = ids.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [ids[i], ids[j]] = [ids[j], ids[i]] }
  const c = lib.currentId != null ? ids.indexOf(lib.currentId) : -1
  if (c > 0) { ids.splice(c, 1); ids.unshift(lib.currentId!) }
  order = ids
}
/** neighbour in play order (dir ±1), honouring repeat-all wrap; null at the ends */
function neighbour(dir: 1 | -1): number | null {
  const n = order.length
  if (!n) return null
  const i = lib.currentId != null ? order.indexOf(lib.currentId) : -1
  // step over flagged (unplayable) tracks
  for (let step = 1; step <= n; step++) {
    let j = i + dir * step
    if (j < 0 || j >= n) {
      if (lib.repeat !== 'all') return null
      j = ((j % n) + n) % n
    }
    const id = order[j]
    if (id === lib.currentId) return null
    if (!lib.tracks[id]?.failed && !unreachable.has(id)) return id
  }
  return null
}
export const hasNext = computed(() => { void lib.currentId; void lib.repeat; void lib.shuffle; void lib.playlists; return neighbour(1) != null })

// ───────────────────────────── prefetch cache ─────────────────────────────
interface Prepared { pcm: { mono: Float32Array; fs: number } | null; analysis: Analysis | null; look: RecordLook | null; vinyl: HTMLCanvasElement }
/** wait for an idle moment so background work never lands in the middle of an animation frame */
const idle = () => new Promise<void>(r => ('requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout: 600 }) : setTimeout(r, 16)))
const cache = new Map<number, Prepared>()
const inflight = new Map<number, Promise<Prepared>>()
const progressTo = new Map<number, (p: number, stage: string) => void>()

function prepare(t: Track): Promise<Prepared> {
  const hit = cache.get(t.id)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(t.id)
  if (running) return running
  const p = (async () => {
    const blob = await sourceOf(t)
    // links / device songs arrive without a cover: take it from the file's own tags now that we have the file
    if (!t.cover) {
      const tags = await readTags(blob).catch(() => null)
      if (tags?.cover) { t.cover = tags.cover; t.coverUrl = URL.createObjectURL(tags.cover); persistTrack(t) }
    }
    const lk = t.cover ? await lookFromCover(t.cover) : null
    // analysis off (Settings): no full decode, no melody / tempo work — just the record and the sound
    if (!settings.analysis) {
      await idle()
      const prep: Prepared = { pcm: null, analysis: null, look: lk, vinyl: buildVinyl(t.title, 0, 1024, lk) }
      cache.set(t.id, prep)
      return prep
    }
    const pcm = await decodeToMono(blob)
    const res = await analyze(pcm.mono, pcm.fs, 'mix', (pr, s) => progressTo.get(t.id)?.(pr, s))
    await idle()
    const vinyl = buildVinyl(t.title, 0, 1024, lk)
    const prep = { pcm: { mono: pcm.mono, fs: pcm.fs }, analysis: res, look: lk, vinyl }
    cache.set(t.id, prep)
    return prep
  })()
  inflight.set(t.id, p)
  p.finally(() => inflight.delete(t.id)).catch(() => {})
  return p
}
/** keep only the current track and its two neighbours decoded (≈ 30 MB each for a 5-minute song) */
function trimCache() {
  const keep = new Set([lib.currentId, neighbour(1), neighbour(-1)])
  for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id)
  // streamed link audio is only held for the deck and its neighbours
  for (const t of Object.values(lib.tracks)) if (t.url && t.blob && !keep.has(t.id) && !inflight.has(t.id)) t.blob = null
}
async function prefetchNeighbours() {
  for (const id of [neighbour(1), neighbour(-1)]) {
    const t = id != null ? lib.tracks[id] : null
    // a neighbour that can't be fetched/decoded gets flagged now, so playback skips straight past it
    if (t) await prepare(t).catch(e => { if (isOffline(e)) unreachable.add(t.id); else markFailed(t, reasonOf(e)) })
  }
  trimCache()
}
/** the audio for a track: the stored file, or the link downloaded (with progress) */
const downloads = new Map<number, Promise<Blob>>()
function sourceOf(t: Track): Promise<Blob> {
  if (t.blob) return Promise.resolve(t.blob)
  if (!t.url) return Promise.reject(new Error('the audio for this track is missing'))
  const running = downloads.get(t.id)
  if (running) return running
  const remote = !isDeviceUrl(t.url)
  const p = (async () => {
    // a link played before is kept on the device: no network needed
    if (t.cached) {
      const kept = await loadAudio(t.id)
      if (kept) { t.blob = markRaw(kept); return kept }
      t.cached = false
    }
    const b = await download(t.url!, f => progressTo.get(t.id)?.(f * 0.25, 'downloading'))
    t.blob = markRaw(b)
    // keep it for offline listening (device songs are local already)
    if (remote && await saveAudio(t.id, b)) { t.cached = true; persistTrack(t) }
    return b
  })()
  downloads.set(t.id, p)
  p.finally(() => downloads.delete(t.id)).catch(() => {})
  return p
}
/** remember that a track can't be played (persisted): it's skipped from now on, never retried on its own */
function markFailed(t: Track, reason: string) {
  logEvent('track-failed', reason, { source: t.url ? (isDeviceUrl(t.url) ? 'phone' : 'link') : 'file' })
  t.failed = reason
  cache.delete(t.id)
  if (t.url) t.blob = null
  persistTrack(t)
}
/** user asked to try a flagged track again */
export function retryTrack(id: number) {
  const t = lib.tracks[id]
  if (!t) return
  t.failed = null
  persistTrack(t)
  if (t.url && !isDeviceUrl(t.url)) void probeLink(t)
  else void playTrack(id, lib.viewId, true)
}

// ───────────────────────────── loading onto the deck ─────────────────────────────
async function load(trackId: number, autoplay: boolean) {
  const t = lib.tracks[trackId]
  if (!t) return
  const token = ++loadToken
  // let the music dip out instead of cutting off
  if (playing.value && lib.currentId !== trackId) await fadeOut(0.16)
  if (token !== loadToken) return
  lib.currentId = trackId
  persistState()
  analysis.value = null; resetActive()
  meta.title = t.title
  meta.subtitle = t.artist ? `now spinning · ${t.artist}` : 'now spinning'
  status.message = ''
  const ready = cache.has(t.id)
  if (!ready) { status.loading = true; status.stage = 'reading'; status.progress = 0 }
  progressTo.set(t.id, (p, s) => { if (token === loadToken) { status.progress = p; status.stage = s } })
  try {
    // a link that still has to download: take the old record off first instead of leaving it spinning silently
    if (!t.blob) { unloadSource(); status.stage = 'downloading' }
    const blob = await sourceOf(t)
    if (token !== loadToken) return
    loadSource(blob)
    const prep = await prepare(t)
    progressTo.delete(t.id)
    if (token !== loadToken) return
    look.value = prep.look
    vinylTex.value = prep.vinyl
    setPcm(prep.pcm?.mono ?? null, prep.pcm?.fs)
    analysis.value = prep.analysis
    meta.hue = hueFor(t.title, prep.analysis?.specs?.key)
    resetActive()
    if (prep.analysis && !prep.analysis.notes.length) status.message = 'No clear melody found in this track.'
    status.loading = false
    if (autoplay) play()
    // get the neighbours ready a little later, not while the arm is cueing and the record is spinning up
    setTimeout(() => { if (token === loadToken) void prefetchNeighbours() }, 5000)
  } catch (e) {
    if (token !== loadToken) return
    progressTo.delete(t.id)
    status.loading = false
    if (isOffline(e)) {
      // no network: skip it for now (it'll play again once online — or anytime, once it's been played online)
      unreachable.add(t.id)
      status.message = `Skipped “${t.title}” for now — ${(e as Error).message || 'no connection'}. It’ll play once it can download.`
    } else {
      // flag it and move on to the next playable track
      markFailed(t, reasonOf(e))
      status.message = `Skipped “${t.title}” — ${t.failed}.`
    }
    const nxt = neighbour(1)
    if (nxt != null) void load(nxt, autoplay)
    else { ++loadToken; unloadSource(); analysis.value = null; vinylTex.value = null; resetActive() }
  }
}
/** the element itself gave up mid-play (corrupt data, stream cut): same treatment */
audio.addEventListener('error', () => {
  const t = current.value
  if (!t || !audio.currentSrc.startsWith('blob:') || status.loading) return
  markFailed(t, 'playback stopped with an error')
  status.message = `Skipped “${t.title}” — ${t.failed}.`
  const nxt = neighbour(1)
  if (nxt != null) void load(nxt, true)
})

/**
 * Analysis switched on/off in Settings: drop prepared neighbours (they were made the other way) and redo the
 * song on the deck from where it was, so the melody lanes / visualizer swap right away.
 */
export async function applyAnalysisSetting() {
  cache.clear()
  const id = lib.currentId
  if (id == null) return
  const at = audio.currentTime, was = playing.value
  await load(id, was)
  if (at > 1) seek(at)
}

/** play a track from a playlist (defaults to the one in view) */
export function playTrack(trackId: number, playlistId = lib.viewId, autoplay = true) {
  const f = lib.tracks[trackId]?.failed
  if (f) { status.message = `Can’t play this one — ${f}. Use “Try again” in its menu to retry.`; return Promise.resolve() }
  unreachable.delete(trackId)
  const switching = playlistId !== lib.playingId
  lib.playingId = playlistId
  lib.currentId = trackId
  if (switching || lib.shuffle) rebuildOrder()
  return load(trackId, autoplay)
}

export function next(auto = false) {
  if (auto && lib.repeat === 'one' && lib.currentId != null) { seek(0); play(); return }
  const id = neighbour(1)
  if (id != null) return load(id, true)
}
/** restart the track if we're past 3 s (with the backspin), otherwise step back */
export function prev() {
  const id = neighbour(-1)
  if (audio.currentTime > 3 || id == null) { seek(0); return }
  return load(id, true)
}
function stopAndUnload() {
  ++loadToken
  unloadSource()
  lib.currentId = null
  analysis.value = null; look.value = null; vinylTex.value = null; resetActive()
  meta.title = 'Gramophone'; meta.subtitle = ''
  status.loading = false
}

// ───────────────────────────── adding music ─────────────────────────────
/** an existing library track with this key (same file content / same link) */
/**
 * One add operation's view of the library for duplicate checks, built once (O(n)) instead of searching the whole
 * library per song — with thousands of songs a per-song search made a phone scan crawl.
 */
interface AddCtx { seen: Set<string>; index: Map<string, number>; inList: Set<number> }
function addCtx(pl: Playlist): AddCtx {
  const index = new Map<string, number>()
  for (const t of Object.values(lib.tracks)) if (t.key) index.set(t.key, t.id)
  return { seen: new Set(), index, inList: new Set(pl.trackIds) }
}
function report(added: number, dupes: number, what = 'track') {
  const parts: string[] = []
  if (added) parts.push(`Added ${added} ${what}${added === 1 ? '' : 's'}`)
  if (dupes) parts.push(`${added ? 'skipped' : 'Skipped'} ${dupes} duplicate${dupes === 1 ? '' : 's'}`)
  status.message = parts.length ? parts.join(' · ') : 'Nothing new to add.'
}
/**
 * Duplicate rule for anything being added to a playlist: if the same file/link is already in that playlist it's
 * skipped; if it's in the library (another playlist) the existing track is reused instead of storing a copy.
 * Returns the id to add, or null when it's a duplicate here.
 */
function reuseOrNull(key: string | null, ctx: AddCtx): { id: number | null; dup: boolean } {
  if (!key) return { id: null, dup: false }
  if (ctx.seen.has(key)) return { id: null, dup: true }
  ctx.seen.add(key)
  const ex = ctx.index.get(key)
  if (ex == null) return { id: null, dup: false }
  if (ctx.inList.has(ex)) return { id: null, dup: true }
  ctx.inList.add(ex)
  return { id: ex, dup: false }
}

export async function addFiles(files: FileList | File[], playlistId = lib.viewId) {
  const list = [...files].filter(f => f.type.startsWith('audio/') || AUDIO_RE.test(f.name))
  if (!list.length) { status.message = 'Those files don’t look like audio.'; return }
  status.message = ''
  const pl = plById(playlistId) ?? ensurePlaylist()
  const startNew = lib.currentId == null
  const firstNew: number[] = [], ctx = addCtx(pl)
  let dupes = 0
  for (const f of list) {
    const key = await fileKey(f).catch(() => null)
    const r = reuseOrNull(key, ctx)
    if (r.dup) { dupes++; continue }
    if (r.id != null) { pl.trackIds.push(r.id); firstNew.push(r.id); continue }
    const tags = await readTags(f).catch(() => ({ cover: null }))
    const t: Track = {
      id: nextTrackId++, blob: markRaw(f), url: null, key, failed: null,
      title: ('title' in tags && tags.title?.trim()) || baseName(f.name),
      artist: ('artist' in tags && tags.artist?.trim()) || '',
      cover: tags.cover, coverUrl: tags.cover ? URL.createObjectURL(tags.cover) : null,
      duration: null,
    }
    lib.tracks[t.id] = t
    pl.trackIds.push(t.id)
    firstNew.push(t.id)
    if (key) ctx.index.set(key, t.id)
    persistTrack(t)
    probeDuration(f).then(d => { const r = lib.tracks[t.id]; if (r) { r.duration = d; persistTrack(r) } })
  }
  report(firstNew.length, dupes)
  if (!firstNew.length) return
  if (pl.id === lib.playingId) rebuildOrder()
  persistState()
  if (startNew) await playTrack(firstNew[0], pl.id, true)
  else void prefetchNeighbours()
}

/**
 * Add tracks from pasted text: any number of direct audio links, and .m3u / .pls playlist links (expanded).
 * Entries appear at once (titled from the file name); each link is then checked in the background — tags and
 * cover read from its first 256 KB, duration from its metadata — and flagged if it can't be used.
 */
export async function addLinks(text: string, playlistId = lib.viewId): Promise<number> {
  const found = extractUrls(text)
  if (!found.length) { status.message = 'No links found in what you pasted.'; return 0 }
  const pl = plById(playlistId) ?? ensurePlaylist()
  const urls: string[] = []
  for (const u of found) {
    if (!isPlaylistUrl(u)) { urls.push(u); continue }
    try { urls.push(...await expandPlaylist(u)) } catch (e) { status.message = 'Couldn’t open that playlist link — ' + reasonOf(e) + '.' }
  }
  const startNew = lib.currentId == null
  const added: number[] = [], ctx = addCtx(pl), fresh: Track[] = []
  let dupes = 0
  for (const u of urls) {
    const key = urlKey(u)
    const r = reuseOrNull(key, ctx)
    if (r.dup) { dupes++; continue }
    if (r.id != null) { pl.trackIds.push(r.id); added.push(r.id); continue }
    const t: Track = {
      id: nextTrackId++, blob: null, url: u, key, failed: null,
      title: titleFromUrl(u), artist: hostOf(u), cover: null, coverUrl: null, duration: null,
    }
    lib.tracks[t.id] = t
    pl.trackIds.push(t.id)
    // keep the reactive proxy: the background check mutates it and the list must update
    added.push(t.id); fresh.push(lib.tracks[t.id])
    persistTrack(t)
  }
  report(added.length, dupes, 'link')
  if (!added.length) return 0
  if (pl.id === lib.playingId) rebuildOrder()
  persistState()
  // check links a few at a time; start playing the first one that works
  void (async () => {
    const queue = [...fresh]
    let started = !startNew
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        await probeLink(t)
        if (!started && !t.failed && lib.currentId == null) { started = true; void playTrack(t.id, pl.id, true) }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    const bad = fresh.filter(t => t.failed).length
    if (bad) status.message = `${bad} of ${fresh.length} link${fresh.length === 1 ? '' : 's'} can’t be played — marked in the list.`
    void prefetchNeighbours()
  })()
  return added.length
}
// ───────────────────────────── phone music (Android app) ─────────────────────────────
export const DEVICE_LIST = 'On this phone'
const contentUriOf = (url: string) => 'content://' + url.split('/_capacitor_content_/')[1]
/**
 * Find the songs on the phone and keep the "On this phone" playlist in step with them: new songs are added,
 * songs that were deleted from the phone are dropped. `quiet` (app start) never asks for permission and only
 * speaks up when something new turned up.
 */
/** where the last phone scan stands — the first-run card and Settings show it (with retry / report actions) */
export const scanState = reactive({
  phase: 'idle' as 'idle' | 'scanning' | 'denied' | 'blocked' | 'empty' | 'error' | 'done',
  error: '', found: 0,
})
export async function scanPhone(opts: { quiet?: boolean } = {}) {
  if (!isNative || scanState.phase === 'scanning') return
  const t0 = performance.now()
  let acc = await musicAccess()
  if (!acc.granted) {
    if (opts.quiet) return
    acc = await requestMusicAccess()
  }
  if (!acc.granted) {
    // "denied" = asked and refused for good (Android won't ask again) → only the app's settings can fix it
    scanState.phase = acc.state === 'denied' ? 'blocked' : 'denied'
    Object.assign(lastScan, { at: new Date().toISOString(), outcome: 'no-permission:' + acc.state, found: 0, added: 0, removed: 0, stats: null, error: null })
    logEvent('scan', 'music access not granted: ' + acc.state)
    return
  }
  if (!opts.quiet) { scanState.phase = 'scanning'; status.message = 'Looking for music on this phone…' }
  let res
  try { res = await scanDevice() } catch (e) {
    scanState.phase = 'error'; scanState.error = reasonOf(e)
    Object.assign(lastScan, { at: new Date().toISOString(), outcome: 'error', found: 0, added: 0, removed: 0, stats: null, error: reasonOf(e) })
    logEvent('scan', 'scan failed: ' + reasonOf(e))
    status.message = 'Couldn’t read the phone’s music — ' + reasonOf(e)
    return
  }
  const songs = res.songs

  let pl = lib.playlists.find(p => p.name === DEVICE_LIST)
  if (!pl) {
    // reuse an empty starter playlist instead of leaving "My queue" empty next to it
    const empty = lib.playlists.length === 1 && !lib.playlists[0].trackIds.length ? lib.playlists[0] : null
    if (empty) { empty.name = DEVICE_LIST; pl = empty }
    else { pl = { id: nextPlaylistId++, name: DEVICE_LIST, trackIds: [] }; lib.playlists.push(pl) }
    pl = plById(pl.id)!
  }
  const present = new Set<string>(), ctx = addCtx(pl), fresh: Track[] = []
  const ids = [...pl.trackIds]
  let added = 0
  for (const s of songs) {
    const key = 'm:' + s.uri
    present.add(key)
    const r = reuseOrNull(key, ctx)
    if (r.dup) continue
    if (r.id != null) { ids.push(r.id); added++; continue }
    const t: Track = {
      id: nextTrackId++, blob: null, url: deviceSrc(s.uri), key, failed: null,
      title: s.title || baseName(s.name), artist: s.artist, cover: null, coverUrl: null, duration: s.duration || null,
    }
    lib.tracks[t.id] = t
    ids.push(t.id)
    fresh.push(lib.tracks[t.id])
    added++
  }
  // songs removed from the phone leave the list
  const gone = new Set(ids.filter(id => { const k = lib.tracks[id]?.key; return !!k && k.startsWith('m:') && !present.has(k) }))
  // one assignment (not thousands of pushes on a reactive array)
  pl.trackIds = gone.size ? ids.filter(id => !gone.has(id)) : ids
  if (gone.size) collectGarbage([...gone])

  scanState.phase = songs.length ? 'done' : 'empty'
  scanState.found = songs.length; scanState.error = ''
  Object.assign(lastScan, { at: new Date().toISOString(), outcome: songs.length ? 'ok' : 'empty', found: songs.length, added, removed: gone.size, stats: res.stats, error: null, ms: Math.round(performance.now() - t0) })
  logEvent('scan', `found ${songs.length}, added ${added}, removed ${gone.size}`, res.stats ? { ...res.stats } : undefined)
  if (!opts.quiet || added) {
    status.message = !songs.length ? 'No songs found on this phone.'
      : added ? `Found ${added} ${opts.quiet ? 'new ' : ''}song${added === 1 ? '' : 's'} on this phone.`
      : `All ${songs.length} songs on this phone are already here.`
  }
  if (!opts.quiet) lib.viewId = pl.id
  if (pl.id === lib.playingId) rebuildOrder()
  persistState()
  if (lib.currentId == null && pl.trackIds.length) void playTrack(pl.trackIds[0], pl.id, false)
  // all new songs in one write; their covers are fetched later, only when they scroll into view (ensureArtwork)
  if (fresh.length) void saveTracks(fresh.map(storedOf))
}

/** read tags/cover from the start of a link and its duration; flag it when it can't be used */
async function probeLink(t: Track) {
  if (!t.url) return
  try {
    const r = await fetchSoon(t.url, { headers: { Range: 'bytes=0-262143' } })
    checkAudioResponse(r)
    const head = await r.blob()
    const tags = await readTags(head).catch(() => null)
    if (tags && 'title' in tags && tags.title?.trim()) t.title = tags.title.trim()
    if (tags && 'artist' in tags && tags.artist?.trim()) t.artist = tags.artist.trim()
    if (tags?.cover) { t.cover = tags.cover; t.coverUrl = URL.createObjectURL(tags.cover) }
    t.duration = await probeDuration(t.url)
    if (t.duration == null) throw new LinkError('it isn’t a format this browser can play')
    persistTrack(t)
  } catch (e) {
    if (isOffline(e)) return
    markFailed(t, reasonOf(e))
  }
}

// ───────────────────────────── playlist editing ─────────────────────────────
function ensurePlaylist(): Playlist {
  if (!lib.playlists.length) {
    lib.playlists.push({ id: nextPlaylistId++, name: 'My queue', trackIds: [] })
    lib.viewId = lib.playingId = lib.playlists[0].id
  }
  return plById(lib.viewId) ?? lib.playlists[0]
}
export function createPlaylist(name = 'New playlist') {
  const p: Playlist = { id: nextPlaylistId++, name: name.trim() || 'New playlist', trackIds: [] }
  lib.playlists.push(p)
  lib.viewId = p.id
  persistState()
  return p.id
}
export function viewPlaylist(id: number) { if (plById(id)) { lib.viewId = id; persistState() } }
export function renamePlaylist(id: number, name: string) { const p = plById(id); if (p && name.trim()) { p.name = name.trim(); persistState() } }
export function deletePlaylist(id: number) {
  const i = lib.playlists.findIndex(p => p.id === id)
  if (i < 0) return
  const [gone] = lib.playlists.splice(i, 1)
  if (lib.playingId === id) stopAndUnload()
  if (!lib.playlists.length) ensurePlaylist()
  if (lib.viewId === id) lib.viewId = lib.playlists[Math.max(0, i - 1)].id
  if (lib.playingId === id) { lib.playingId = lib.viewId; order = [] }
  collectGarbage(gone.trackIds)
  persistState()
}
export function removeFromPlaylist(playlistId: number, trackId: number) {
  const p = plById(playlistId)
  if (!p) return
  p.trackIds = p.trackIds.filter(id => id !== trackId)
  if (playlistId === lib.playingId) {
    if (trackId === lib.currentId) {
      const nxt = neighbour(1)
      rebuildOrder()
      if (nxt != null && nxt !== trackId) void load(nxt, playing.value)
      else stopAndUnload()
    } else rebuildOrder()
  }
  collectGarbage([trackId])
  persistState()
}
export function clearPlaylist(playlistId = lib.viewId) {
  const p = plById(playlistId)
  if (!p) return
  const ids = p.trackIds
  p.trackIds = []
  if (playlistId === lib.playingId) { stopAndUnload(); order = [] }
  collectGarbage(ids)
  persistState()
}
export function reversePlaylist(playlistId = lib.viewId) {
  const p = plById(playlistId)
  if (!p) return
  p.trackIds.reverse()
  if (playlistId === lib.playingId && !lib.shuffle) rebuildOrder()
  persistState()
  void prefetchNeighbours()
}
export function moveTrack(playlistId: number, from: number, to: number) {
  const p = plById(playlistId)
  if (!p || from === to) return
  const [id] = p.trackIds.splice(from, 1)
  p.trackIds.splice(to, 0, id)
  if (playlistId === lib.playingId && !lib.shuffle) rebuildOrder()
  persistState()
  void prefetchNeighbours()
}
/** add an existing track to another playlist (no duplicates) */
export function addToPlaylist(playlistId: number, trackId: number) {
  const p = plById(playlistId)
  if (!p || p.trackIds.includes(trackId)) return
  p.trackIds.push(trackId)
  if (playlistId === lib.playingId) rebuildOrder()
  persistState()
}
/** drop repeated entries (same track, or same file/link added twice before duplicate detection existed) */
export function removeDuplicates(playlistId = lib.viewId): number {
  const p = plById(playlistId)
  if (!p) return 0
  const seen = new Set<string>(), keep: number[] = [], gone: number[] = []
  for (const id of p.trackIds) {
    const k = lib.tracks[id]?.key ?? 'id:' + id
    if (seen.has(k) || seen.has('id:' + id)) { gone.push(id); continue }
    seen.add(k); seen.add('id:' + id); keep.push(id)
  }
  if (!gone.length) { status.message = 'No duplicates in this playlist.'; return 0 }
  p.trackIds = keep
  if (playlistId === lib.playingId) rebuildOrder()
  collectGarbage(gone)
  persistState()
  status.message = `Removed ${gone.length} duplicate${gone.length === 1 ? '' : 's'}.`
  return gone.length
}
/** queue a track to play right after the current one (in the playing playlist) */
export function playNext(trackId: number) {
  if (lib.currentId == null || trackId === lib.currentId) return
  const p = plById(lib.playingId)
  if (!p) return
  const from = p.trackIds.indexOf(trackId)
  if (from >= 0) p.trackIds.splice(from, 1)
  p.trackIds.splice(p.trackIds.indexOf(lib.currentId) + 1, 0, trackId)
  // put it next in the play order too (also when shuffled)
  const o = order.indexOf(trackId)
  if (o >= 0) order.splice(o, 1)
  order.splice(order.indexOf(lib.currentId) + 1, 0, trackId)
  persistState()
  void prefetchNeighbours()
}

/** tracks that are in no playlist any more: drop their audio from storage and memory */
function collectGarbage(candidates: number[]) {
  const used = new Set(lib.playlists.flatMap(p => p.trackIds))
  for (const id of candidates) {
    if (used.has(id) || id === lib.currentId) continue
    const t = lib.tracks[id]
    if (t?.coverUrl) URL.revokeObjectURL(t.coverUrl)
    delete lib.tracks[id]
    cache.delete(id)
    unreachable.delete(id)
    void deleteTrack(id)
    void deleteAudio(id)
  }
}

// ───────────────────────────── modes + volume ─────────────────────────────
export function toggleShuffle() { lib.shuffle = !lib.shuffle; rebuildOrder(); persistState(); void prefetchNeighbours() }
export function cycleRepeat() { lib.repeat = lib.repeat === 'off' ? 'all' : lib.repeat === 'all' ? 'one' : 'off'; persistState(); void prefetchNeighbours() }
export function setVol(v: number) { lib.volume = Math.min(1, Math.max(0, v)); lib.muted = lib.volume === 0 ? lib.muted : false; applyVolume(); persistState() }
export function toggleMute() { lib.muted = !lib.muted; applyVolume(); persistState() }
const applyVolume = () => setVolume(lib.muted ? 0 : lib.volume)

export const totalDuration = computed(() => viewTracks.value.reduce((a, t) => a + (t.duration ?? 0), 0))

// ───────────────────────────── persistence ─────────────────────────────
function persistState() {
  void saveState({
    playlists: lib.playlists.map(p => ({ id: p.id, name: p.name, trackIds: [...p.trackIds] })),
    viewId: lib.viewId, playingId: lib.playingId,
    currentId: lib.currentId, time: lib.currentId != null ? audio.currentTime : 0,
    shuffle: lib.shuffle, repeat: lib.repeat, volume: lib.volume, muted: lib.muted,
  })
}
const storedOf = (t: Track): StoredTrack => ({
  id: t.id, blob: t.url ? null : t.blob, url: t.url, key: t.key, failed: t.failed, cached: !!t.cached,
  title: t.title, artist: t.artist, cover: t.cover, duration: t.duration,
})
const persistTrack = (t: Track) => { void saveTrack(storedOf(t)) }

/**
 * Cover art for songs from the phone, fetched on demand (the list asks for the rows it's showing), two at a time,
 * newest request first — so a 2,000-song library never decodes 2,000 thumbnails up front.
 */
const artQueue: number[] = [], artTried = new Set<number>()
let artBusy = 0
export function ensureArtwork(id: number) {
  const t = lib.tracks[id]
  if (!t || t.cover || !isDeviceUrl(t.url) || artTried.has(id)) return
  artTried.add(id)
  artQueue.push(id)
  void pumpArt()
}
async function pumpArt() {
  while (artBusy < 2 && artQueue.length) {
    const id = artQueue.pop()!
    artBusy++
    try {
      const t = lib.tracks[id]
      if (t?.url && !t.cover) {
        const art = await deviceArtwork(contentUriOf(t.url))
        if (art && lib.tracks[id]) { t.cover = art; t.coverUrl = URL.createObjectURL(art); persistTrack(t) }
      }
    } finally { artBusy-- }
  }
}

/** Bring back library, playlists, modes and the needle position. Returns false when nothing was saved. */
export async function restoreLibrary(): Promise<boolean> {
  const { tracks, state } = await loadAll()
  for (const t of tracks) {
    lib.tracks[t.id] = {
      ...t, blob: t.blob ? markRaw(t.blob) : null, url: t.url ?? null, key: t.key ?? null, failed: t.failed ?? null, cached: !!t.cached,
      coverUrl: t.cover ? URL.createObjectURL(t.cover) : null,
    }
    nextTrackId = Math.max(nextTrackId, t.id + 1)
  }
  // fingerprint files saved before duplicate detection existed (in the background)
  void (async () => {
    for (const t of Object.values(lib.tracks)) {
      if (t.key || !t.blob) continue
      await idle()
      t.key = await fileKey(t.blob).catch(() => null)
      if (t.key) persistTrack(t)
    }
  })()
  const st: StoredState | null = state
  if (st?.playlists?.length) lib.playlists = st.playlists.map(p => ({ ...p, trackIds: p.trackIds.filter(id => lib.tracks[id]) }))
  else if (tracks.length) lib.playlists = [{ id: 1, name: 'My queue', trackIds: (st?.order ?? tracks.map(t => t.id)).filter(id => lib.tracks[id]) }] // v1 migration
  for (const p of lib.playlists) nextPlaylistId = Math.max(nextPlaylistId, p.id + 1)
  ensurePlaylist()
  lib.viewId = plById(st?.viewId ?? -1)?.id ?? lib.playlists[0].id
  lib.playingId = plById(st?.playingId ?? -1)?.id ?? lib.viewId
  lib.shuffle = !!st?.shuffle; lib.repeat = st?.repeat ?? 'off'
  lib.volume = st?.volume ?? 1; lib.muted = !!st?.muted
  applyVolume()
  const cur = st?.currentId != null && lib.tracks[st.currentId] && !lib.tracks[st.currentId].failed ? st.currentId : null
  lib.currentId = cur
  rebuildOrder()
  if (cur == null) return tracks.length > 0
  await load(cur, false)
  if (st && st.time > 0) seek(st.time)
  return true
}

// keep the needle position fresh: every 2 s while playing, and whenever playback pauses or the page goes away
setInterval(() => { if (!audio.paused) persistState() }, 2000)
audio.addEventListener('pause', persistState)
addEventListener('pagehide', persistState)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistState() })
// end of a side → repeat-one / next / stop
audio.addEventListener('ended', () => { void next(true) })

// dev-only handle for inspecting the library from the console
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__lib = { lib, cache, order: () => order }
