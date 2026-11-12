/**
 * Diagnostics report: one structured, copy/share-able text that tells what kind of device this is, how the app is
 * set up and what happened recently — enough to decide what to fix, without any song names or files.
 */
import { lib } from './library'
import { layout } from './layout'
import { deviceInfo, isDeviceUrl, isNative, musicAccess, nativeShare } from './native'
import { perf, settings, tier } from './settings'
import { events, lastScan } from './diagLog'

declare const __APP_VERSION__: string

export async function buildReport() {
  const tracks = Object.values(lib.tracks)
  const nav = navigator as Navigator & { deviceMemory?: number }
  let storage: unknown = null
  try { const e = await navigator.storage?.estimate?.(); if (e) storage = { usedMB: Math.round((e.usage ?? 0) / 1e6), quotaMB: Math.round((e.quota ?? 0) / 1e6) } } catch { /* */ }
  const report = {
    report: 'gramophone-diagnostics/1',
    createdAt: new Date().toISOString(),
    app: { version: __APP_VERSION__, platform: isNative ? 'android' : 'web', standalone: matchMedia('(display-mode: standalone)').matches },
    device: {
      ...(await deviceInfo() ?? {}),
      userAgent: navigator.userAgent,
      language: navigator.language,
      cores: nav.hardwareConcurrency ?? null,
      memoryGB: nav.deviceMemory ?? null,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
      viewport: `${layout.W}x${layout.H}`, layout: layout.mobile ? 'stacked' : 'side-by-side',
      online: navigator.onLine,
    },
    musicAccess: isNative ? (await musicAccess()).state : 'n/a',
    settings: { ...settings, effectiveQuality: tier.value },
    performance: { avgFrameMs: perf.frameMs || null, framesMeasured: perf.samples, autoTier: perf.auto },
    library: {
      tracks: tracks.length,
      playlists: lib.playlists.length,
      fromPhone: tracks.filter(t => isDeviceUrl(t.url)).length,
      links: tracks.filter(t => t.url && !isDeviceUrl(t.url)).length,
      files: tracks.filter(t => !t.url).length,
      savedOffline: tracks.filter(t => t.cached).length,
      unavailable: tracks.filter(t => t.failed).length,
      failureReasons: [...new Set(tracks.map(t => t.failed).filter(Boolean))].slice(0, 10),
    },
    lastScan,
    storage,
    recentEvents: events.slice(-25),
  }
  return report
}

export async function reportText() {
  const r = await buildReport()
  return `Gramophone diagnostics — please send this to the developer.\n\n${JSON.stringify(r, null, 2)}`
}

/** share via the system sheet (Android), the Web Share API, or fall back to the clipboard. Returns what happened. */
export async function shareReport(): Promise<'shared' | 'copied' | 'failed'> {
  const text = await reportText()
  try {
    if (isNative) { await nativeShare('Gramophone diagnostics', text); return 'shared' }
    if (navigator.share) { await navigator.share({ title: 'Gramophone diagnostics', text }); return 'shared' }
  } catch { /* cancelled or unsupported → copy */ }
  return copyReport(text)
}
export async function copyReport(text?: string): Promise<'copied' | 'failed'> {
  try { await navigator.clipboard.writeText(text ?? await reportText()); return 'copied' } catch { return 'failed' }
}
