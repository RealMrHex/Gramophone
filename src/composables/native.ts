/**
 * Native (Capacitor / Android) bridge. Everything here is a no-op in the browser.
 *
 * Device songs come from Android's MediaStore through the app's own MusicLibrary plugin
 * (android/app/src/main/java/.../MusicLibraryPlugin.java). Each song is a content:// uri that the WebView
 * reads through Capacitor's local server, so it behaves like any same-origin link: full decode + analysis.
 */
import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core'

export const isNative = Capacitor.isNativePlatform()

export interface DeviceSong {
  id: number
  uri: string
  title: string
  artist: string
  album: string
  /** seconds */
  duration: number
  size: number
  mime: string
  name: string
  added: number
  folder: string
}
interface Access { granted: boolean; state: string }
export interface ScanStats { totalAudio: number; matched: number; ms: number; volumes: string }
interface MusicLibraryPlugin {
  access(): Promise<Access>
  request(): Promise<Access>
  scan(opts?: { minDurationMs?: number }): Promise<{ songs: DeviceSong[]; stats?: ScanStats }>
  artwork(opts: { uri: string; size?: number }): Promise<{ jpeg?: string }>
  info(): Promise<Record<string, unknown>>
  openSettings(): Promise<void>
  share(opts: { title: string; text: string }): Promise<void>
}
const MusicLibrary = registerPlugin<MusicLibraryPlugin>('MusicLibrary')

/** the URL the WebView can fetch a device song from */
export const deviceSrc = (uri: string) => Capacitor.convertFileSrc(uri)
export const isDeviceUrl = (u: string | null | undefined) => !!u && u.includes('/_capacitor_content_/')

export async function musicAccess(): Promise<Access> {
  if (!isNative) return { granted: false, state: 'unsupported' }
  try { return await MusicLibrary.access() } catch { return { granted: false, state: 'unsupported' } }
}
/** ask for permission if needed; resolves with the final state */
export async function requestMusicAccess(): Promise<Access> {
  if (!isNative) return { granted: false, state: 'unsupported' }
  return MusicLibrary.request()
}
export async function scanDevice(): Promise<{ songs: DeviceSong[]; stats: ScanStats | null }> {
  const { songs, stats } = await MusicLibrary.scan({ minDurationMs: 20000 })
  return { songs, stats: stats ?? null }
}
/** device / app facts for diagnostics (model, Android version, WebView, permission state) */
export async function deviceInfo(): Promise<Record<string, unknown> | null> {
  if (!isNative) return null
  try { return await MusicLibrary.info() } catch { return null }
}
/** Android's app-info screen, to turn music access back on */
export async function openAppSettings() { if (isNative) await MusicLibrary.openSettings().catch(() => {}) }
/** the system share sheet (native) */
export async function nativeShare(title: string, text: string) { await MusicLibrary.share({ title, text }) }
/** small cover thumbnail as a Blob, or null when the song has none */
export async function deviceArtwork(uri: string): Promise<Blob | null> {
  try {
    const { jpeg } = await MusicLibrary.artwork({ uri, size: 320 })
    if (!jpeg) return null
    const bin = atob(jpeg), bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: 'image/jpeg' })
  } catch { return null }
}

/** light status/navigation bar icons over the dark app */
export function setupNativeChrome() {
  if (!isNative) return
  void SystemBars.setStyle({ style: SystemBarsStyle.Dark }).catch(() => {})
}
