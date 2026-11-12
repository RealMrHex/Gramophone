import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.arminnotes.gramophone',
  appName: 'Gramophone',
  webDir: 'dist',
  backgroundColor: '#050506',
  // the bridge would otherwise log every plugin result (album-art thumbnails are big base64 strings)
  loggingBehavior: 'none',
  android: {
    // links are streamed over https; the in-app page itself is served from https://localhost
    allowMixedContent: false,
  },
  plugins: {
    // edge-to-edge: the page draws under the status / navigation bars (viewport-fit=cover) and pads itself
    // with env(safe-area-inset-*), which this makes correct on every Android WebView version
    SystemBars: { insetsHandling: 'native', style: 'DARK' },
  },
}

export default config
