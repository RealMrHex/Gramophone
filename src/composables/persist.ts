/**
 * Queue persistence in IndexedDB: the audio files themselves (Blobs), their tags/cover, the queue order,
 * which track is on the deck and where the needle was. Everything fails soft — if storage is unavailable
 * (private mode, quota) the app just behaves as an in-memory queue.
 */
export interface StoredTrack {
  id: number
  /** the audio itself for local files; null for link tracks (they are fetched again when played) */
  blob: Blob | null
  /** direct link the track was added from */
  url?: string | null
  /** duplicate-detection key: content fingerprint for files, normalised URL for links */
  key?: string | null
  /** why the track can't be played; flagged tracks are skipped and never retried automatically */
  failed?: string | null
  /** a link track whose audio has been downloaded and kept (store "audio") — it plays offline */
  cached?: boolean
  title: string
  artist: string
  cover: Blob | null
  duration: number | null
}
export interface StoredPlaylist { id: number; name: string; trackIds: number[] }
export interface StoredState {
  /** v1 (single queue) only */
  order?: number[]
  playlists?: StoredPlaylist[]
  viewId?: number
  playingId?: number
  currentId: number | null
  time: number
  shuffle?: boolean
  repeat?: 'off' | 'all' | 'one'
  volume?: number
  muted?: boolean
}

const DB = 'gramophone', VERSION = 2
let dbp: Promise<IDBDatabase | null> | null = null
let onBlocked: (() => void) | null = null
/** called if storage is waiting for another (older) Gramophone tab to close */
export function whenStorageBlocked(fn: () => void) { onBlocked = fn }

function db(): Promise<IDBDatabase | null> {
  if (!dbp) {
    dbp = new Promise(res => {
      try {
        const req = indexedDB.open(DB, VERSION)
        req.onupgradeneeded = () => {
          const d = req.result
          if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' })
          if (!d.objectStoreNames.contains('state')) d.createObjectStore('state')
          // v2: downloaded audio of link tracks, kept apart from the track list so the list loads fast
          if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio')
        }
        req.onsuccess = () => {
          const d = req.result
          // a newer version of the app (another tab) needs to upgrade the database: step aside and reload into it,
          // instead of blocking it forever
          d.onversionchange = () => { d.close(); location.reload() }
          res(d)
        }
        req.onerror = () => res(null)
        // an older tab still has the database open; it reloads itself when it runs the code above — until then, say so
        req.onblocked = () => { onBlocked?.() }
      } catch { res(null) }
    })
  }
  return dbp
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return db().then(d => new Promise(res => {
    if (!d) return res(null)
    try {
      const t = d.transaction(store, mode), s = t.objectStore(store)
      const r = fn(s)
      t.oncomplete = () => res(r ? (r.result as T) : null)
      t.onerror = () => res(null)
      t.onabort = () => res(null)
    } catch { res(null) }
  }))
}

export const saveTrack = (t: StoredTrack) => tx('tracks', 'readwrite', s => { s.put(t) })
/** many tracks in one transaction (a phone scan can add thousands) */
export const saveTracks = (list: StoredTrack[]) => tx('tracks', 'readwrite', s => { for (const t of list) s.put(t) })
export const deleteTrack = (id: number) => tx('tracks', 'readwrite', s => { s.delete(id) })
export const saveState = (st: StoredState) => tx('state', 'readwrite', s => { s.put(st, 'main') })
/** offline copies of link tracks */
export const saveAudio = (id: number, blob: Blob) => tx('audio', 'readwrite', s => s.put(blob, id)).then(r => r !== null)
export const loadAudio = (id: number) => tx<Blob>('audio', 'readonly', s => s.get(id))
export const deleteAudio = (id: number) => tx('audio', 'readwrite', s => { s.delete(id) })

export async function loadAll(): Promise<{ tracks: StoredTrack[]; state: StoredState | null }> {
  const [tracks, state] = await Promise.all([
    tx<StoredTrack[]>('tracks', 'readonly', s => s.getAll()),
    tx<StoredState>('state', 'readonly', s => s.get('main')),
  ])
  return { tracks: tracks ?? [], state: state ?? null }
}
