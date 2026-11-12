/**
 * Embedded track metadata: cover art + title/artist, read straight from the file bytes.
 * Supports ID3v2.2/2.3/2.4 (MP3), MP4/M4A (`covr`, `©nam`, `©ART`) and FLAC (PICTURE + VORBIS_COMMENT).
 */
export interface TrackTags {
  cover: Blob | null
  title?: string
  artist?: string
}

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const syncsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]
const sniffMime = (d: Uint8Array) => (d[0] === 0x89 && d[1] === 0x50 ? 'image/png' : d[0] === 0x52 && d[1] === 0x49 ? 'image/webp' : 'image/jpeg')

function decodeText(enc: number, d: Uint8Array): string {
  try {
    if (enc === 0) return new TextDecoder('latin1').decode(d).replace(/\0+$/, '')
    if (enc === 3) return new TextDecoder('utf-8').decode(d).replace(/\0+$/, '')
    if (enc === 2) return new TextDecoder('utf-16be').decode(d).replace(/\0+$/, '')
    // enc 1: UTF-16 with BOM
    const le = d[0] === 0xff && d[1] === 0xfe
    return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(d.subarray(2)).replace(/\0+$/, '')
  } catch { return '' }
}

function readId3(b: Uint8Array): TrackTags | null {
  if (ascii(b, 0, 3) !== 'ID3') return null
  const ver = b[3], flags = b[5], size = syncsafe(b, 6)
  const end = Math.min(b.length, 10 + size)
  let p = 10
  if (flags & 0x40) p += ver === 4 ? syncsafe(b, p) : u32(b, p) + 4
  const out: TrackTags = { cover: null }
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10
  while (p + hdr <= end) {
    const id = ascii(b, p, idLen)
    if (!/^[A-Z0-9]+$/.test(id)) break
    const fsz = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? syncsafe(b, p + 4) : u32(b, p + 4)
    const d = b.subarray(p + hdr, p + hdr + fsz)
    p += hdr + fsz
    if (!fsz || d.length < fsz) break
    if (id === 'TIT2' || id === 'TT2') out.title = decodeText(d[0], d.subarray(1))
    else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(d[0], d.subarray(1))
    else if ((id === 'APIC' || id === 'PIC') && !out.cover) {
      const enc = d[0]
      let q = 1
      if (id === 'PIC') q += 3 // 3-char image format
      else { while (q < d.length && d[q] !== 0) q++; q++ } // mime
      q++ // picture type
      if (enc === 1 || enc === 2) { while (q + 1 < d.length && (d[q] !== 0 || d[q + 1] !== 0)) q += 2; q += 2 }
      else { while (q < d.length && d[q] !== 0) q++; q++ }
      const img = d.subarray(q)
      if (img.length > 64) out.cover = new Blob([img.slice()], { type: sniffMime(img) })
    }
  }
  return out
}

function readFlac(b: Uint8Array): TrackTags | null {
  if (ascii(b, 0, 4) !== 'fLaC') return null
  const out: TrackTags = { cover: null }
  let p = 4
  for (;;) {
    if (p + 4 > b.length) break
    const last = b[p] & 0x80, type = b[p] & 0x7f, len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]
    const d = b.subarray(p + 4, p + 4 + len)
    if (type === 6 && !out.cover) {
      let q = 4
      const ml = u32(d, q); q += 4 + ml
      const dl = u32(d, q); q += 4 + dl + 16
      const n = u32(d, q); q += 4
      out.cover = new Blob([d.slice(q, q + n)], { type: sniffMime(d.subarray(q)) })
    } else if (type === 4) {
      const le = (o: number) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)
      let q = 4 + le(0)
      const count = le(q); q += 4
      for (let i = 0; i < count && q < d.length; i++) {
        const l = le(q); q += 4
        const kv = new TextDecoder().decode(d.subarray(q, q + l)); q += l
        const [k, ...v] = kv.split('=')
        if (k.toUpperCase() === 'TITLE') out.title = v.join('=')
        if (k.toUpperCase() === 'ARTIST') out.artist = v.join('=')
      }
    }
    p += 4 + len
    if (last) break
  }
  return out
}

function readMp4(b: Uint8Array): TrackTags | null {
  if (ascii(b, 4, 4) !== 'ftyp') return null
  const out: TrackTags = { cover: null }
  // atoms we want sit under moov/udta/meta/ilst; a byte scan for the item name + its `data` child is robust enough
  const find = (tag: number[]) => {
    for (let i = 0; i < b.length - 16; i++) {
      if (b[i] === tag[0] && b[i + 1] === tag[1] && b[i + 2] === tag[2] && b[i + 3] === tag[3] && ascii(b, i + 8, 4) === 'data') {
        const size = u32(b, i + 4)
        return b.subarray(i + 20, i + 4 + size)
      }
    }
    return null
  }
  const covr = find([0x63, 0x6f, 0x76, 0x72])
  if (covr && covr.length > 64) out.cover = new Blob([covr.slice()], { type: sniffMime(covr) })
  const nam = find([0xa9, 0x6e, 0x61, 0x6d]), art = find([0xa9, 0x41, 0x52, 0x54])
  if (nam) out.title = new TextDecoder().decode(nam)
  if (art) out.artist = new TextDecoder().decode(art)
  return out
}

export async function readTags(blob: Blob): Promise<TrackTags> {
  // tags live at the start for ID3/FLAC; MP4 metadata can be anywhere, but files are small enough to scan
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer())
  let bytes: Uint8Array
  if (ascii(head, 0, 3) === 'ID3') {
    const size = syncsafe(head, 6) + 10
    bytes = new Uint8Array(await blob.slice(0, size).arrayBuffer())
  } else {
    bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 64 * 1024 * 1024)).arrayBuffer())
  }
  try {
    return readId3(bytes) ?? readFlac(bytes) ?? readMp4(bytes) ?? { cover: null }
  } catch {
    return { cover: null }
  }
}
