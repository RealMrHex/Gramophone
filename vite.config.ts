import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import pkg from './package.json' with { type: 'json' }

/**
 * Offline: after a build, list every file in dist/ (hashed JS/CSS, the analysis worker, icons, manifest) inside
 * dist/sw.js, so the service worker precaches the whole app on install — it then opens and works with no network,
 * even for parts that were never loaded while online.
 */
function precacheManifest(): Plugin {
  let outDir = 'dist'
  return {
    name: 'gramophone-precache',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir },
    closeBundle() {
      const files: string[] = []
      const walk = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n)
          if (statSync(p).isDirectory()) walk(p)
          // og.jpg is only for link previews on other sites — no need to store it on every device
          else if (n !== 'sw.js' && n !== 'og.jpg' && !n.endsWith('.map')) files.push('./' + relative(outDir, p).split('\\').join('/'))
        }
      }
      walk(outDir)
      const sw = join(outDir, 'sw.js')
      const src = readFileSync(sw, 'utf8')
      const version = String(files.length) + '-' + Date.now().toString(36)
      writeFileSync(sw, src
        .replace(/const PRECACHE = \[[^\]]*\]/, `const PRECACHE = ${JSON.stringify(files)}`)
        .replace(/const BUILD = '[^']*'/, `const BUILD = '${version}'`))
    },
  }
}

export default defineConfig({
  plugins: [vue(), precacheManifest()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  worker: { format: 'es' },
  // the Android project and built APKs live next to the web app; don't reload the page when they change
  server: { watch: { ignored: ['**/android/**', '**/release/**'] } },
})
