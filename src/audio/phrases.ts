import type { Analysis, Engine, Line, Note, Specs, Token } from '../types'
import { NAMES, median, noteName } from './music'

function lcsRatio(a: number[], b: number[]) {
  const m = a.length, n = b.length
  if (!m || !n) return 0
  let prev = new Array(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0)
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    prev = cur
  }
  return prev[n] / Math.max(m, n)
}
const intervals = (m: number[]) => m.slice(1).map((v, i) => v - m[i])

const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const corr = (a: number[], b: number[]) => {
  const ma = a.reduce((s, v) => s + v) / 12, mb = b.reduce((s, v) => s + v) / 12
  let n = 0, da = 0, db = 0
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2 }
  return n / Math.sqrt(da * db || 1)
}

/** notes -> lines of tokens, hook / verse clustering, key & tempo. */
export function buildPhrases(notes: Note[], engine: Engine, tempoBpm?: number): Analysis {
  if (!notes.length) return { booms: [], notes: [], lines: [], flat: [], specs: null, engine }

  const medDur = median(notes.map(q => q.t1 - q.t0))
  const gapThr = Math.max(0.28, 1.6 * medDur)
  const iois: number[] = []
  for (let i = 0; i < notes.length - 1; i++) if (notes[i + 1].t0 - notes[i].t1 < gapThr) iois.push(notes[i + 1].t0 - notes[i].t0)
  const medIOI = median(iois) || medDur
  notes.forEach((q, i) => {
    const nx = notes[i + 1]
    q.fast = !!nx && nx.t0 - q.t1 < gapThr && nx.t0 - q.t0 < 0.7 * medIOI
  })

  const groups: Note[][] = []
  let L: Note[] = []
  for (const q of notes) {
    if (L.length && (q.t0 - L[L.length - 1].t1 > gapThr || L.length >= 9)) { groups.push(L); L = [] }
    L.push(q)
  }
  if (L.length) groups.push(L)

  // clustering on both absolute pitch and transposition-invariant intervals
  type Cluster = { rep: number[]; ids: number[]; label: string }
  const clusters: Cluster[] = []
  const clusterOf: Cluster[] = []
  const thr = engine === 'solo' ? 0.75 : 0.66
  groups.forEach((g, i) => {
    const p = g.map(q => q.midi)
    let c: Cluster | undefined
    if (p.length >= 4) c = clusters.find(c => c.rep.length >= 4 && Math.max(lcsRatio(c.rep, p), lcsRatio(intervals(c.rep), intervals(p))) >= thr)
    if (!c) { c = { rep: p, ids: [], label: '' }; clusters.push(c) }
    c.ids.push(i); clusterOf[i] = c
  })
  const multi = clusters.filter(c => c.ids.length >= 2)
    .sort((a, b) => b.ids.length - a.ids.length || clusters.indexOf(a) - clusters.indexOf(b))
  const cn = ['hook', 'verse', 'bridge', 'refrain', 'break']
  multi.forEach((c, i) => (c.label = cn[i] ?? cn[1 + ((i - 1) % (cn.length - 1))]))
  const labels = groups.map((_, i) => clusterOf[i].label)
  const isHook = labels.map(l => l === 'hook')
  if (clusterOf[0].ids.length === 1) labels[0] = 'intro'
  const lastI = groups.length - 1
  if (lastI > 0 && clusterOf[lastI].ids.length === 1) labels[lastI] = 'outro'
  // one-off lines belong to the section they sit in: inherit the previous line's section (a line after a hook or
  // the intro falls back to the main non-hook section), so every row carries a label
  const fallback = multi.find(c => c.label !== 'hook')?.label ?? 'verse'
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) continue
    const prev = labels[i - 1]
    labels[i] = !prev || prev === 'hook' || prev === 'intro' ? fallback : prev
  }

  const flat: Token[] = []
  const lines: Line[] = groups.map((g, li) => {
    const toks: Token[] = g.map(q => ({ text: '', midi: q.midi, t0: q.t0, t1: q.t1, g: q.fast, line: li, gi: 0 }))
    const starts: boolean[] = [], ends: boolean[] = []
    g.forEach((q, i) => {
      const pf = i > 0 && !!g[i - 1].fast, nf = i < g.length - 1 && !!g[i + 1].fast
      starts[i] = !!q.fast && !pf; ends[i] = !!q.fast && !nf
    })
    toks.forEach((t, i) => {
      if (starts[i] && ends[i]) { t.g = false; starts[i] = ends[i] = false }
      t.text = (starts[i] ? '[' : '') + noteName(t.midi!) + (ends[i] ? ']' : '')
    })
    const last = g[g.length - 1], nx = groups[li + 1]?.[0]
    if (nx && nx.t0 - last.t1 > gapThr) {
      const gap = nx.t0 - last.t1, nr = Math.min(2, Math.max(1, Math.round(gap / (1.5 * medDur))))
      for (let k = 0; k < nr; k++) toks.push({ rest: true, text: '_', t0: last.t1 + (k * gap) / nr, t1: last.t1 + ((k + 1) * gap) / nr, line: li, gi: 0 })
    }
    toks.forEach(t => { t.gi = flat.length; flat.push(t) })
    return { label: labels[li], tokens: toks, hook: isHook[li] }
  })

  // key, tempo, range
  const hist = new Array(12).fill(0)
  notes.forEach(q => (hist[((q.midi % 12) + 12) % 12] += q.t1 - q.t0))
  let best = { r: -2, k: 0, mode: 'major' }
  for (let k = 0; k < 12; k++) {
    const a = Array.from({ length: 12 }, (_, i) => hist[(i + k) % 12])
    const rM = corr(MAJ, a), rm = corr(MIN, a)
    if (rM > best.r) best = { r: rM, k, mode: 'major' }
    if (rm > best.r) best = { r: rm, k, mode: 'minor' }
  }
  // prefer the audio-based tempo; fall back to melody note spacing only if it couldn't be measured
  let bpm = tempoBpm ?? 60 / medIOI
  if (tempoBpm == null) { while (bpm > 160) bpm /= 2; while (bpm < 70) bpm *= 2 }
  const ms = notes.map(q => q.midi)
  const hc = multi[0]
  const specs: Specs = {
    key: NAMES[best.k] + ' ' + best.mode,
    bpm: Math.round(bpm),
    notes: notes.length,
    range: noteName(Math.min(...ms)) + '–' + noteName(Math.max(...ms)),
    hook: hc ? { count: hc.ids.length, dur: groups[hc.ids[0]].at(-1)!.t1 - groups[hc.ids[0]][0].t0 } : null,
  }
  return { booms: [], notes, lines, flat, specs, engine }
}
