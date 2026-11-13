/*
 * Gramophone service worker: makes the app installable and lets it open offline.
 *  - the whole build (page, JS/CSS, analysis worker, icons, manifest) is precached on install
 *  - navigations: network first, falling back to the cached page when offline
 *  - hashed build assets (/assets/*) and icons: cache first (their names change when they change)
 * Your music itself never goes through here — it lives in IndexedDB and plays from blob: URLs.
 */
// filled in at build time (vite.config.ts → precacheManifest): every file of the build, and a build id
const PRECACHE = []
const BUILD = 'dev'
const CACHE = 'gramophone-' + BUILD
// songs / links shared to the app from other apps (Android "Share to Gramophone"), waiting for the page to import
const SHARE = 'gramophone-share'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/favicon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png']

self.addEventListener('install', e => {
  self.skipWaiting()
  // the whole app, so it runs fully offline from the first visit on
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([...new Set([...SHELL, ...PRECACHE])])))
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return }
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res })
        .catch(() => caches.match('./index.html')),
    )
    return
  }

  const cacheable = url.pathname.includes('/assets/') || url.pathname.includes('/icons/')
  if (!cacheable) return
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)) }
      return res
    })),
  )
})

/**
 * Android share sheet → installed Gramophone: keep the shared files (and any shared text / link) in a cache, then
 * open the app, which imports them (App.vue → importShared) and clears the cache.
 */
async function receiveShare(req) {
  const back = new URL('./?share=1', self.registration.scope).href
  try {
    const form = await req.formData()
    const box = await caches.open(SHARE)
    for (const k of await box.keys()) await box.delete(k)
    let i = 0
    for (const f of form.getAll('audio')) {
      if (!f || typeof f === 'string') continue
      await box.put(new URL(`./__share/${i++}/${encodeURIComponent(f.name || 'shared audio')}`, self.registration.scope).href,
        new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }))
    }
    const text = ['title', 'text', 'url'].map(k => form.get(k)).filter(v => typeof v === 'string' && v).join('\n')
    if (text) await box.put(new URL('./__share/text', self.registration.scope).href, new Response(text))
  } catch (e) { /* nothing usable was shared — just open the app */ }
  return Response.redirect(back, 303)
}
