import { hashStr, makeCanvas, mulberry32 } from './rand'
import type { RecordLook } from './palette'

const TAU = Math.PI * 2

let tile: HTMLCanvasElement | null = null
/** 128² monochrome noise, built once */
function noiseTile() {
  if (tile) return tile
  tile = makeCanvas(128, 128)
  const g = tile.getContext('2d')!, img = g.createImageData(128, 128), d = img.data
  for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255 }
  g.putImageData(img, 0, 0)
  return tile
}

/**
 * Cosy warm palette: analogous rose / terracotta / apricot over wine and plum, softer saturation, a touch of cream.
 * (Duplicates weight the pick, so rose and wine dominate and cream stays rare.)
 */
const COZY = ['#b5566c', '#b5566c', '#c9715a', '#dd9a66', '#6b2c45', '#6b2c45', '#8a4a62', '#efcfae']

/**
 * Marbled coloured-vinyl record texture (rotates rigidly with the disc).
 * With a `look` (from the track's cover art) the marble uses the cover's palette and the label *is* the cover.
 */
export function buildVinyl(title: string, _hue: number, size = 1200, look: RecordLook | null = null): HTMLCanvasElement {
  const c = makeCanvas(size, size), g = c.getContext('2d')!
  const R = size / 2, rnd = mulberry32(hashStr(title) || 1)
  const pal = look?.palette.length ? look.palette : COZY
  g.save()
  g.beginPath(); g.arc(R, R, R - 4, 0, TAU); g.clip()
  g.fillStyle = look?.base ?? '#2a1219'; g.fillRect(0, 0, size, size)

  // soft marbling: fat blurred strokes + blobs
  g.filter = 'blur(38px)'
  g.lineCap = 'round'
  for (let i = 0; i < 16; i++) {
    const p = () => R + (rnd() - 0.5) * size * 1.1
    g.strokeStyle = pal[(rnd() * pal.length) | 0]; g.globalAlpha = 0.55 + rnd() * 0.4
    g.lineWidth = 60 + rnd() * 150
    g.beginPath(); g.moveTo(p(), p()); g.bezierCurveTo(p(), p(), p(), p(), p(), p()); g.stroke()
  }
  for (let i = 0; i < 26; i++) {
    const a = rnd() * TAU, r = R * (0.2 + rnd() * 0.8)
    g.globalAlpha = 0.5 + rnd() * 0.4; g.fillStyle = pal[(rnd() * pal.length) | 0]
    g.save(); g.translate(R + Math.cos(a) * r, R + Math.sin(a) * r); g.rotate(rnd() * TAU); g.scale(1, 0.3 + rnd() * 0.6)
    g.beginPath(); g.arc(0, 0, 70 + rnd() * 170, 0, TAU); g.fill(); g.restore()
  }
  // crisper swirl ribbons
  g.filter = 'blur(7px)'
  for (let i = 0; i < 9; i++) {
    const p = () => R + (rnd() - 0.5) * size
    g.strokeStyle = pal[(rnd() * pal.length) | 0]; g.globalAlpha = 0.35 + rnd() * 0.3
    g.lineWidth = 5 + rnd() * 18
    g.beginPath(); g.moveTo(p(), p()); g.bezierCurveTo(p(), p(), p(), p(), p(), p()); g.stroke()
  }
  g.filter = 'none'; g.globalAlpha = 1

  // darken slightly toward rim/label so grooves read
  const vg = g.createRadialGradient(R, R, R * 0.3, R, R, R)
  vg.addColorStop(0, 'rgba(0,0,0,.12)'); vg.addColorStop(.85, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.28)')
  g.fillStyle = vg; g.fillRect(0, 0, size, size)

  // grooves with smooth track gaps
  const gaps = [0.5, 0.66, 0.81].map(f => f * R)
  for (let r = R * 0.38; r < R * 0.972; r += 2.7) {
    if (gaps.some(gp => Math.abs(r - gp) < 5)) continue
    const n = Math.sin(r * 1.7) * 0.5 + Math.sin(r * 0.37) * 0.5
    g.beginPath(); g.arc(R, R, r, 0, TAU)
    g.strokeStyle = n > 0.35 ? 'rgba(255,255,255,.085)' : `rgba(0,0,0,${0.16 + (n + 1) * 0.07})`
    g.lineWidth = 1; g.stroke()
  }
  gaps.forEach(gp => {
    g.beginPath(); g.arc(R, R, gp, 0, TAU); g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 4; g.stroke()
    g.beginPath(); g.arc(R, R, gp + 4, 0, TAU); g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1; g.stroke()
  })

  // fine grain (dust / press noise): a small noise tile repeated — same look, a fraction of the cost
  g.globalAlpha = 0.07; g.fillStyle = g.createPattern(noiseTile(), 'repeat')!; g.fillRect(0, 0, size, size); g.globalAlpha = 1
  g.restore()

  // bevelled rim
  const rim = g.createRadialGradient(R, R, R - 16, R, R, R)
  rim.addColorStop(0, 'rgba(0,0,0,0)'); rim.addColorStop(.55, 'rgba(255,255,255,.12)'); rim.addColorStop(1, 'rgba(0,0,0,.9)')
  g.beginPath(); g.arc(R, R, R - 1, 0, TAU); g.arc(R, R, R - 16, 0, TAU, true); g.fillStyle = rim; g.fill()

  // raised lip around the label
  const lr = R * 0.37
  const lip = g.createRadialGradient(R, R, lr, R, R, lr + R * 0.07)
  lip.addColorStop(0, 'rgba(0,0,0,.85)'); lip.addColorStop(.4, 'rgba(255,255,255,.14)'); lip.addColorStop(1, 'rgba(0,0,0,0)')
  g.beginPath(); g.arc(R, R, lr + R * 0.07, 0, TAU); g.fillStyle = lip; g.fill()

  if (look?.cover) {
    drawCoverLabel(g, R, lr, look.cover)
    return c
  }

  // paper label
  const lg = g.createRadialGradient(R - lr * 0.2, R - lr * 0.25, 0, R, R, lr)
  lg.addColorStop(0, '#fff4e6'); lg.addColorStop(.55, '#f4dccb'); lg.addColorStop(1, '#e2b9a6')
  g.beginPath(); g.arc(R, R, lr, 0, TAU); g.fillStyle = lg; g.fill()
  const ld = g.getImageData(R - lr, R - lr, lr * 2, lr * 2), p = ld.data
  for (let i = 0; i < p.length; i += 4) { const v = (rnd() - 0.5) * 14; p[i] += v; p[i + 1] += v; p[i + 2] += v }
  // keep label circular: re-clip when putting back
  g.save(); g.beginPath(); g.arc(R, R, lr, 0, TAU); g.clip(); g.putImageData(ld, R - lr, R - lr); g.restore()
  g.beginPath(); g.arc(R, R, lr, 0, TAU); g.strokeStyle = 'rgba(40,20,50,.25)'; g.lineWidth = 2; g.stroke()
  g.beginPath(); g.arc(R, R, lr * 0.93, 0, TAU); g.strokeStyle = 'rgba(40,20,50,.18)'; g.lineWidth = 1; g.stroke()

  g.fillStyle = 'rgba(38,24,48,.82)'; g.textAlign = 'center'; g.textBaseline = 'middle'
  const arcText = (str: string, rad: number, mid: number, px: number) => {
    g.font = `600 ${px}px ui-sans-serif,system-ui,sans-serif`
    const step = (px * 0.8) / rad
    let a = mid - ((str.length - 1) * step) / 2
    for (const ch of str) {
      g.save(); g.translate(R, R); g.rotate(a + Math.PI / 2); g.translate(0, -rad); g.fillText(ch, 0, 0); g.restore()
      a += step
    }
  }
  arcText(title.toUpperCase().slice(0, 30), lr * 0.84, -Math.PI / 2, 16)
  arcText('PRESSED ONTO PIXELS · 33⅓ RPM · STEREO', lr * 0.84, Math.PI / 2, 14)
  g.fillStyle = '#c4553f'; g.font = '34px ui-sans-serif'; g.fillText('✺', R + lr * 0.46, R)
  g.fillStyle = 'rgba(38,24,48,.88)'; g.font = '800 64px ui-sans-serif,system-ui'; g.fillText('A', R - lr * 0.5, R + 2)
  // spindle
  const sp = g.createRadialGradient(R, R, 0, R, R, 16)
  sp.addColorStop(0, '#000'); sp.addColorStop(.6, '#050505'); sp.addColorStop(1, '#aaa')
  g.beginPath(); g.arc(R, R, 15, 0, TAU); g.fillStyle = sp; g.fill()
  return c
}

/** Cover art as the centre label: centre-cropped square, clipped round, with a printed-paper edge and the spindle hole. */
function drawCoverLabel(g: CanvasRenderingContext2D, R: number, lr: number, img: ImageBitmap) {
  const side = Math.min(img.width, img.height)
  const sx = (img.width - side) / 2, sy = (img.height - side) / 2
  g.save()
  g.beginPath(); g.arc(R, R, lr, 0, TAU); g.clip()
  g.drawImage(img, sx, sy, side, side, R - lr, R - lr, lr * 2, lr * 2)
  // soft edge vignette + a faint sheen so it reads as a printed label on the record, not a pasted image
  const v = g.createRadialGradient(R, R, lr * 0.55, R, R, lr)
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.28)')
  g.fillStyle = v; g.fillRect(R - lr, R - lr, lr * 2, lr * 2)
  g.restore()
  g.beginPath(); g.arc(R, R, lr, 0, TAU); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 3; g.stroke()
  g.beginPath(); g.arc(R, R, lr - 3, 0, TAU); g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.stroke()
  // spindle hole with a small ring
  g.beginPath(); g.arc(R, R, 24, 0, TAU); g.fillStyle = 'rgba(0,0,0,.25)'; g.fill()
  const sp = g.createRadialGradient(R, R, 0, R, R, 16)
  sp.addColorStop(0, '#000'); sp.addColorStop(.6, '#050505'); sp.addColorStop(1, '#aaa')
  g.beginPath(); g.arc(R, R, 15, 0, TAU); g.fillStyle = sp; g.fill()
}

/** Static light reflection - drawn over the rotating disc but NOT rotated, which is what sells the vinyl. */
export function buildSheen(size = 1200): HTMLCanvasElement {
  const c = makeCanvas(size, size), g = c.getContext('2d')!, R = size / 2
  const lobe = (start: number, peak: number) => {
    const cg = g.createConicGradient(start, R, R)
    cg.addColorStop(0, `rgba(255,255,255,${peak})`)
    cg.addColorStop(0.035, `rgba(255,255,255,${peak * 0.45})`)
    cg.addColorStop(0.09, 'rgba(255,255,255,0)')
    cg.addColorStop(0.91, 'rgba(255,255,255,0)')
    cg.addColorStop(0.965, `rgba(255,255,255,${peak * 0.45})`)
    cg.addColorStop(1, `rgba(255,255,255,${peak})`)
    g.fillStyle = cg; g.fillRect(0, 0, size, size)
  }
  lobe(-0.55, 0.34)
  lobe(Math.PI - 0.55, 0.22)
  g.globalCompositeOperation = 'destination-in'
  const m = g.createRadialGradient(R, R, R * 0.34, R, R, R)
  m.addColorStop(0, 'rgba(0,0,0,0)'); m.addColorStop(.1, 'rgba(0,0,0,1)'); m.addColorStop(.96, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = m; g.beginPath(); g.arc(R, R, R - 3, 0, TAU); g.fill()
  return c
}
