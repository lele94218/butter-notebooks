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
        globPatterns: ['**/*.{js,css,svg,png,woff,woff2,ttf}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Don't serve the SPA shell for anything that isn't the app itself.
        // /v1/* is token-gated streaming API; /jupyter/* is a separate app
        // rendered in an iframe — both must always hit the network untouched.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/v1\//, /^\/jupyter\//, /^\/_stats\//, /^\/health/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/v1/') ||
              url.pathname.startsWith('/jupyter/') ||
              url.pathname.startsWith('/_stats/'),
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
