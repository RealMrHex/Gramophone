import { reactive } from 'vue'
import { tier } from './settings'

export const layout = reactive({
  W: 1200, H: 800, R: 300, cx: 80, cy: 400, DPR: 1,
  /** the whole deck (record, ring, arm) is drawn rotated by this about the record centre: 0 on desktop
   *  (record on the left edge), π/2 on phones (record hanging from the top edge, arm coming in from the right) */
  rot: 0,
  /** phone portrait: record on top, melody below, player as a bottom sheet */
  mobile: false,
  /** height of the record canvas: the full window on desktop, only the deck band on phones (fewer pixels to paint) */
  stageH: 800,
  /** phones: the player sheet covers the stage, so the record / lanes stop animating until it closes */
  covered: false,
  /** permanent playlist sidebar on the right (0 on mobile) */
  side: 340,
  /** mobile: height of the collapsed player sheet (mini bar), without the home-indicator inset */
  peek: 0,
  /** device safe-area insets (notch / home indicator) */
  safeTop: 0, safeBottom: 0,
  /** melody lanes: from just right of the record to just left of the sidebar; vertical band on mobile */
  lanesLeft: 500, lanesRight: 364, lanesTop: 0, lanesBottom: 0, laneFont: 28, laneGap: 84,
})

/** reads env(safe-area-inset-*) once per layout pass through a hidden probe */
let probe: HTMLElement | null = null
function safeAreas() {
  if (!probe) {
    probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)'
    document.body.appendChild(probe)
  }
  const s = getComputedStyle(probe)
  return { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0 }
}

export function updateLayout() {
  const W = innerWidth, H = innerHeight
  layout.W = W; layout.H = H
  // canvas pixel density by quality tier: phones can't push 2× full-screen canvases at 60 fps
  const dprCap = tier.value === 'saver' ? 1.25 : tier.value === 'balanced' ? 1.5 : 2
  layout.DPR = Math.min(dprCap, devicePixelRatio || 1)
  const safe = safeAreas()
  layout.safeTop = safe.top; layout.safeBottom = safe.bottom
  // stacked layout (record on top, lines below, player in a bottom sheet) for phones and for any window too narrow
  // to fit the sidebar next to a readable melody area; short landscape windows keep the side-by-side layout
  layout.mobile = (W < 860 && H >= 520) || (W < 760 && H > W * 1.1)

  if (layout.mobile) {
    // the desktop composition turned a quarter: record hanging from the top edge (centre just above it), tonearm
    // pivot on the right edge, progress ring wrapping the bottom. R is set so the pivot lands on the right edge.
    layout.side = 0
    layout.peek = 98
    // phone GPUs: 1.75× is indistinguishable from 2× on a moving record and paints ~25% fewer pixels
    if (matchMedia('(pointer: coarse)').matches) layout.DPR = Math.min(dprCap, 1.75, devicePixelRatio || 1)
    layout.rot = Math.PI / 2
    // short screens (e.g. Safari with its toolbars) get a slightly smaller record so the rest still fits
    layout.R = Math.max(12, Math.min(W * 0.5, H * (H < 740 ? 0.26 : 0.3)))
    // centred; when the width is what limits the record, the arm pivot lands right on the edge
    layout.cx = W / 2
    layout.cy = safe.top * 0.5 + layout.R * 0.3
    layout.laneFont = Math.round(Math.min(19, Math.max(15, W / 23)))
    layout.laneGap = Math.round(layout.laneFont * 2.5)
    layout.lanesLeft = Math.round(W * 0.15)
    layout.lanesRight = 0
    layout.lanesTop = layout.cy + layout.R * 1.24
    layout.lanesBottom = layout.peek + safe.bottom + 34
    // the glow reaches ~1.35R past the centre; nothing is drawn below that
    layout.stageH = Math.min(H, Math.ceil(layout.cy + layout.R * 1.55))
    return
  }

  layout.side = Math.round(Math.min(420, Math.max(330, W * 0.28)))
  layout.peek = 0
  layout.rot = 0
  const stageW = W - layout.side
  // proportions measured off the reference (record radius = 0.463·H, centre on the left edge at 0.4925·H,
  // lanes from 1.29R), fitted into the stage area left of the sidebar
  // never collapse below a few px (tiny / hidden windows narrower than the sidebar would make it negative)
  layout.R = Math.max(12, Math.min(H * 0.463, stageW * 0.36))
  layout.cx = 0
  layout.cy = H * 0.4925
  layout.stageH = H
  layout.lanesLeft = layout.R * 1.29
  layout.lanesRight = layout.side + 24
  layout.lanesTop = 0
  layout.lanesBottom = 0
  layout.laneGap = Math.min(H * 0.105, 84)
  // a typical line is ~24em wide: size the notes so a line fits the space between record and sidebar
  layout.laneFont = Math.round(Math.min(30, Math.max(13, (W - layout.lanesRight - layout.lanesLeft) / 24)))
}
