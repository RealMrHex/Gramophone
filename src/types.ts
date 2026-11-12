export interface Note { midi: number; t0: number; t1: number; fast?: boolean }

export interface Token {
  text: string
  t0: number
  t1: number
  rest?: boolean
  /** part of a bracketed fast run */
  g?: boolean
  midi?: number
  line: number
  /** index into the flat token list */
  gi: number
}

export interface Line {
  label: string
  tokens: Token[]
  hook: boolean
}

export interface Specs {
  key: string
  bpm: number
  notes: number
  range: string
  hook: { count: number; dur: number } | null
}

export type Engine = 'mix' | 'solo'

export interface Analysis {
  /** kick / bass hits for the lighting, seconds + strength */
  booms: { t: number; s: number }[]
  notes: Note[]
  lines: Line[]
  flat: Token[]
  specs: Specs | null
  engine: Engine
}

export type WorkerIn = { mono: Float32Array; fs: number; engine: Engine }
export type WorkerOut =
  | { type: 'progress'; p: number; stage: string }
  | { type: 'done'; result: Analysis }
  | { type: 'error'; message: string }
