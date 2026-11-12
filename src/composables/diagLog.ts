/**
 * A small in-memory event log for diagnostics reports: errors, scan results, playback failures.
 * Song names are stripped from messages (“…”), so a report never says what someone listens to.
 */
export interface DiagEvent { t: string; kind: string; msg: string; data?: Record<string, unknown> }

const MAX = 40
export const events: DiagEvent[] = []
/** the last phone scan, in detail */
export const lastScan: { at: string | null; outcome: string; found: number; added: number; removed: number; stats: unknown; error: string | null } =
  { at: null, outcome: 'never', found: 0, added: 0, removed: 0, stats: null, error: null }

const scrub = (s: string) => s.replace(/“[^”]*”/g, '“…”').replace(/"[^"]{2,}"/g, '"…"').slice(0, 300)

export function logEvent(kind: string, msg: string, data?: Record<string, unknown>) {
  events.push({ t: new Date().toISOString(), kind, msg: scrub(msg), data })
  if (events.length > MAX) events.shift()
}

if (typeof window !== 'undefined') {
  addEventListener('error', e => logEvent('error', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`))
  addEventListener('unhandledrejection', e => logEvent('rejection', String((e.reason as Error)?.message ?? e.reason)))
}
