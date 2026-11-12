/**
 * Direct links + duplicate keys.
 *
 * A link track is streamed from its URL when it plays. The browser only lets the page *read* the audio (needed for
 * the visualiser, melody and tempo) when the host allows it (CORS) — so links are checked when added, and the
 * reason is kept when one can't be used.
 */

/** a link failed for a reason that won't fix itself by retrying (bad status, blocked, not audio) */
export class LinkError extends Error {}
/** no network right now — never a reason to flag a track */
export class OfflineError extends Error {}
export const isOffline = (e: unknown) => e instanceof OfflineError || (typeof navigator !== 'undefined' && navigator.onLine === false)

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi
const PLAYLIST_RE = /\.(m3u8?|pls)(?:[?#]|$)/i
const PAGE_TYPES = /text\/html|application\/(?:xhtml|json)|text\/xml/i

/** every http(s) link in a pasted blob of text, in order, without trailing punctuation */
export function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_RE)].map(m => trimUrl(m[0])).filter(Boolean)
}
/**
 * Drop sentence punctuation after a link, and closing brackets that belong to the surrounding text, e.g.
 * "(see https://x.com/a.mp3)." — but keep brackets that are part of the link, like ".../Mix%20-%20(%20Live%20).mp3".
 */
function trimUrl(u: string): string {
  for (;;) {
    const t = u.replace(/[.,;:!?'"]+$/, '')
    const last = t.slice(-1)
    const pair: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
    if (pair[last]) {
      const opens = t.split(pair[last]).length - 1, closes = t.split(last).length - 1
      if (closes > opens) { u = t.slice(0, -1); continue }
    }
    return t
  }
}
export const isPlaylistUrl = (u: string) => PLAYLIST_RE.test(u)

/** "u:" + the link without its #fragment — two pastes of the same link are the same track */
export function urlKey(u: string) {
  try { const x = new URL(u); x.hash = ''; return 'u:' + x.href } catch { return 'u:' + u.trim() }
}

/** a readable title from the link's file name: ".../My%20Song_(Live).mp3" → "My Song (Live)" */
export function titleFromUrl(u: string) {
  try {
    const seg = new URL(u).pathname.split('/').filter(Boolean).pop() ?? ''
    const name = decodeURIComponent(seg).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+]+/g, ' ').trim()
    return name || new URL(u).hostname
  } catch { return u }
}
export const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

/** fetch that gives up when the server doesn't start answering in time */
export async function fetchSoon(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal, mode: 'cors', credentials: 'omit', redirect: 'follow' })
  } catch (e) {
    clearTimeout(timer)
    if (navigator.onLine === false) throw new OfflineError('you are offline')
    if ((e as Error).name === 'AbortError') throw new LinkError('the link took too long to answer')
    // A TypeError is either the host not allowing other sites to read the file (CORS) or no internet at all (e.g.
    // Wi-Fi without a connection, where the browser still says "online"). An opaque no-cors request tells them
    // apart: it succeeds whenever the server is reachable, CORS or not.
    const reachable = await fetch(url, { mode: 'no-cors', credentials: 'omit', signal: AbortSignal.timeout?.(8000) })
      .then(() => true, () => false)
    if (!reachable) throw new OfflineError('the internet isn’t reachable')
    throw new LinkError('the host doesn’t allow playing it from another site')
  } finally { clearTimeout(timer) }
}
/** status / type checks shared by probing and streaming */
export function checkAudioResponse(r: Response) {
  if (!r.ok) throw new LinkError(r.status === 404 ? 'the link is gone (404)' : `the link answered ${r.status}`)
  const ct = r.headers.get('content-type') ?? ''
  if (PAGE_TYPES.test(ct)) throw new LinkError('that link opens a web page, not an audio file')
}

/** download the whole file, reporting 0‥1 progress when the size is known */
export async function download(url: string, onProgress?: (p: number) => void): Promise<Blob> {
  const r = await fetchSoon(url, {}, 20000)
  checkAudioResponse(r)
  const type = r.headers.get('content-type') || 'audio/mpeg'
  const total = Number(r.headers.get('content-length')) || 0
  if (!r.body || !total || !onProgress) {
    const buf = await r.arrayBuffer().catch(() => { throw new OfflineError('the download was interrupted') })
    return new Blob([buf], { type })
  }
  const reader = r.body.getReader(), parts: Uint8Array[] = []
  let got = 0
  for (;;) {
    // a connection that drops mid-download is temporary — never a reason to flag the track
    const { done, value } = await reader.read().catch(() => { throw new OfflineError('the download was interrupted') })
    if (done) break
    parts.push(value); got += value.length
    onProgress(Math.min(1, got / total))
  }
  return new Blob(parts as BlobPart[], { type })
}

/** expand an .m3u / .m3u8 / .pls playlist link into the track links inside it (relative paths resolved) */
export async function expandPlaylist(url: string): Promise<string[]> {
  const r = await fetchSoon(url)
  if (!r.ok) throw new LinkError(`the playlist link answered ${r.status}`)
  const text = await r.text()
  if (/#EXT-X-(?:TARGETDURATION|MEDIA-SEQUENCE|STREAM-INF)/.test(text)) throw new LinkError('live / HLS streams aren’t supported')
  const lines = text.split(/\r?\n/).map(l => l.trim())
  const raw = /\[playlist\]/i.test(text)
    ? lines.filter(l => /^File\d+=/i.test(l)).map(l => l.replace(/^File\d+=/i, ''))
    : lines.filter(l => l && !l.startsWith('#'))
  return raw.map(l => { try { return new URL(l, url).href } catch { return '' } }).filter(u => /^https?:/i.test(u))
}

/**
 * Content fingerprint for duplicate detection: size + FNV-1a over the first and last 64 KB. Re-adding the same file
 * (any name, any folder) gives the same key; works without crypto.subtle (plain-http LAN dev on a phone).
 */
export async function fileKey(b: Blob): Promise<string> {
  const n = b.size, part = 65536
  const chunks = [new Uint8Array(await b.slice(0, Math.min(n, part)).arrayBuffer())]
  if (n > part * 2) chunks.push(new Uint8Array(await b.slice(n - part).arrayBuffer()))
  let h = 0x811c9dc5
  for (const c of chunks) for (let i = 0; i < c.length; i++) { h ^= c[i]; h = Math.imul(h, 0x01000193) }
  return `f:${n}:${(h >>> 0).toString(36)}`
}

/** a short human reason for any load / decode failure */
export function reasonOf(e: unknown): string {
  if (e instanceof LinkError) return e.message
  const m = (e as Error)?.message ?? ''
  if (/decod|EncodingError|unable to decode/i.test(m) || (e as Error)?.name === 'EncodingError') return 'the audio couldn’t be decoded'
  return m || 'it couldn’t be played'
}
