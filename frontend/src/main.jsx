import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App.jsx'
import { registerSW } from 'virtual:pwa-register'

// Service worker: caches the app shell so the home-screen app opens instantly
// and survives a flaky connection. API calls (/v1/*) always hit the network.
// autoUpdate — a new deploy is picked up on the next load.
registerSW({ immediate: true })

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
