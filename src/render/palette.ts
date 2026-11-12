/**
 * Turn a cover image into a record "look": a weighted marble palette, a dark base, and the cover itself for the label.
 *
 * k-means (k = 6) over a 64×64 downscale finds the cover's main colours. Colourful covers keep their hues but are
 * pulled into a cosy range (softer saturation, mid lightness). Near-monochrome covers (sketches, B&W photos)
 * become a smoky charcoal / graphite / paper marble with a faint warm tint, instead of a flat muddy grey.
 */
export interface RecordLook {
  palette: string[]
  base: string
  cover: ImageBitmap | null
}

type RGB = [number, number, number]

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
const hsl = (h: number, s: number, l: number) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`

function kmeans(px: RGB[], k: number): { c: RGB; n: number }[] {
  // init: spread over the luminance-sorted pixels
  const sorted = [...px].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]))
  let cents: RGB[] = Array.from({ length: k }, (_, i) => [...sorted[Math.floor(((i + 0.5) / k) * sorted.length)]] as RGB)
  let counts = new Array(k).fill(0)
  for (let it = 0; it < 10; it++) {
    const sums = Array.from({ length: k }, () => [0, 0, 0])
    counts = new Array(k).fill(0)
    for (const p of px) {
      let bi = 0, bd = Infinity
      for (let j = 0; j < k; j++) {
        const c = cents[j], d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
        if (d < bd) { bd = d; bi = j }
      }
      sums[bi][0] += p[0]; sums[bi][1] += p[1]; sums[bi][2] += p[2]; counts[bi]++
    }
    cents = cents.map((c, j) => (counts[j] ? [sums[j][0] / counts[j], sums[j][1] / counts[j], sums[j][2] / counts[j]] : c) as RGB)
  }
  return cents.map((c, j) => ({ c, n: counts[j] })).filter(x => x.n > 0).sort((a, b) => b.n - a.n)
}

export async function lookFromCover(cover: Blob): Promise<RecordLook | null> {
  let bmp: ImageBitmap
  try { bmp = await createImageBitmap(cover) } catch { return null }
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bmp, 0, 0, S, S)
  const d = g.getImageData(0, 0, S, S).data
  const px: RGB[] = []
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) px.push([d[i], d[i + 1], d[i + 2]])
  if (px.length < 50) return { palette: [], base: '#2a1219', cover: bmp }

  const clusters = kmeans(px, 6)
  const total = clusters.reduce((a, b) => a + b.n, 0)
  const meanSat = clusters.reduce((a, x) => a + rgbToHsl(x.c)[1] * x.n, 0) / total

  const palette: string[] = []
  const push = (col: string, weight: number) => { for (let i = 0; i < Math.max(1, Math.round(weight * 8)); i++) palette.push(col) }

  if (meanSat < 0.12) {
    // monochrome cover → smoky marble from its own tonal range, warmed very slightly (paper / ink)
    for (const { c: col, n } of clusters) {
      const [, , l] = rgbToHsl(col)
      const tl = 0.14 + l * 0.62 // compress into a record-friendly range
      push(hsl(24, 0.06 + (1 - l) * 0.05, tl), n / total)
    }
    if (!palette.some(p => /hsl\(\d+ \d+% [0-2]\d%\)/.test(p))) push(hsl(20, 0.08, 0.18), 0.25) // keep some ink
    return { palette, base: hsl(20, 0.08, 0.1), cover: bmp }
  }

  // colourful cover → its hues, made cosy
  let darkest: RGB = clusters[0].c, dl = 1
  for (const { c: col, n } of clusters) {
    const [h, s, l] = rgbToHsl(col)
    if (l < dl) { dl = l; darkest = col }
    if (s < 0.08) { push(hsl(h, 0.08, 0.2 + l * 0.5), (n / total) * 0.6); continue } // greys stay as quiet neutrals
    push(hsl(h, Math.min(0.62, Math.max(0.28, s * 0.85)), Math.min(0.7, Math.max(0.3, l))), n / total)
  }
  const [bh] = rgbToHsl(darkest)
  return { palette, base: hsl(bh, 0.3, 0.1), cover: bmp }
}
