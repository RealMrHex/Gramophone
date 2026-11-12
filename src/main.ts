import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { isNative } from './composables/native'

createApp(App).mount('#app')

// installable + offline app shell (production web builds only; the dev server should never be cached, and the
// Android app already ships its files inside the APK)
if (import.meta.env.PROD && !isNative && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {}) })
}
