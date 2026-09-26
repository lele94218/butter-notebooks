import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'butter notebooks',
        short_name: 'butter',
        description: 'AI-powered notebook with Claude',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#131310',
        theme_color: '#131310',
        orientation: 'portrait-primary',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell only.
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ttf}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // NEVER cache the API: responses are token-gated, streamed (SSE) and
        // live data. Let every /v1/* request go straight to the network.
        navigateFallbackDenylist: [/^\/v1\//, /^\/jupyter\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/v1/') || url.pathname.startsWith('/jupyter/'),
            handler: 'NetworkOnly',
          },
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: { enabled: false },
    }),
  ],
})
