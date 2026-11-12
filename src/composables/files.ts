/**
 * Collecting audio from what the user hands us: dropped files and (nested) folders, or a folder picker.
 * Everything comes back in natural path order ("2 - …" before "10 - …"), hidden/system files skipped.
 */
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|webm|aif|aiff)$/i

interface Found { file: File; path: string }

const isAudio = (f: File) => !f.name.startsWith('.') && (f.type.startsWith('audio/') || AUDIO_RE.test(f.name))
const natural = (a: Found, b: Found) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })

const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej))
const readBatch = (r: FileSystemDirectoryReader) => new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej))

async function walk(entry: FileSystemEntry, prefix: string, out: Found[]) {
  if (entry.name.startsWith('.')) return
  if (entry.isFile) {
    const f = await fileOf(entry as FileSystemFileEntry).catch(() => null)
    if (f && isAudio(f)) out.push({ file: f, path: prefix + f.name })
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries returns results in batches (≈100 in Chrome) until it returns an empty one
    for (;;) {
      const batch = await readBatch(reader).catch(() => [] as FileSystemEntry[])
      if (!batch.length) break
      for (const child of batch) await walk(child, prefix + entry.name + '/', out)
    }
  }
}

/**
 * Must be called synchronously inside the drop handler (the DataTransfer is emptied once the event returns);
 * it grabs the entries immediately and resolves with every audio file found, folders included.
 */
export function collectDropped(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items]
    .filter(i => i.kind === 'file')
    .map(i => i.webkitGetAsEntry?.() ?? null)
  const plain = [...dt.files]
  return (async () => {
    if (!entries.some(Boolean)) return plain.filter(isAudio)
    const out: Found[] = []
    for (const e of entries) if (e) await walk(e, '', out)
    return out.sort(natural).map(f => f.file)
  })()
}

/** From an `<input webkitdirectory>` (or a plain multi-file input): audio only, natural path order. */
export function collectPicked(list: FileList): File[] {
  return [...list]
    .filter(isAudio)
    .map(f => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }))
    .sort(natural)
    .map(f => f.file)
}
