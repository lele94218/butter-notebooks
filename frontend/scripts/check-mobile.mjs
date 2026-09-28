// Measure the deployed PWA as an installed iPhone app so layout regressions
// (clipped footers, dead space, elements under the safe areas) can be checked
// without asking for a screenshot.
//
//   node scripts/check-mobile.mjs [url]
//
// Emulates iPhone 15 Pro viewport + display-mode:standalone + the safe-area
// insets iOS reports in full-bleed mode.
import { chromium } from 'playwright'

const URL = process.argv[2] || 'https://your-site.example.com'
const TOKEN = process.env.API_TOKEN || 'your-secret-token'

// iPhone 15 Pro, portrait, full-bleed standalone
const VW = 393, VH = 852
const INSET_TOP = 59, INSET_BOTTOM = 34

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
})
const page = await ctx.newPage()

// Only seed auth. Crucially we do NOT inject --sa-*: Chromium reports
// env(safe-area-inset-*) as 0, matching what WebKit does inside the installed
// app's fixed body, so the app's own runtime inference is what gets tested.
await page.addInitScript((token) => {
  localStorage.setItem('butter_auth_token', token)
  // Look like an iPhone so the app's standalone inference kicks in.
  Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true })
  Object.defineProperty(window.screen, 'height', { value: 852, configurable: true })
}, TOKEN)

await page.emulateMedia({ media: 'screen' })
await page.addInitScript(() => {
  const mm = window.matchMedia.bind(window)
  window.matchMedia = (q) =>
    q.includes('display-mode: standalone')
      ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }
      : mm(q)
})

const report = []
const check = (name, ok, detail) => report.push({ name, ok, detail })

await page.goto(URL, { waitUntil: 'networkidle' })
// Nothing is injected here on purpose. Chromium reports env(safe-area-inset-*)
// as 0 — which is exactly what WebKit does inside the fixed body of the
// installed app — so this exercises the app's own runtime inference of
// --sa-top / --sa-bottom. Give it time to settle (it re-reads at 300/1200ms).
await page.waitForTimeout(1600)
const insets = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement)
  return {
    top: cs.getPropertyValue('--sa-top').trim(),
    bottom: cs.getPropertyValue('--sa-bottom').trim(),
  }
})
check(
  'safe-area insets resolved',
  parseFloat(insets.bottom) >= INSET_BOTTOM,
  `--sa-top=${insets.top} --sa-bottom=${insets.bottom} (need bottom >= ${INSET_BOTTOM}px)`
)

const box = async (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
  }, sel)

// --- chat view ---
const inputArea = await box('.input-area')
const inputRow = await box('.input-row')
const sendBtn = await box('.send-btn')
const textarea = await box('textarea')

if (inputArea) {
  const gap = VH - inputArea.bottom
  check('composer reaches screen bottom', gap === 0, `${gap}px gap below .input-area`)
  const btnToBottom = sendBtn ? VH - sendBtn.bottom : null
  check(
    'send button clear of home indicator',
    btnToBottom !== null && btnToBottom >= INSET_BOTTOM,
    `send button bottom is ${btnToBottom}px from screen bottom (need >= ${INSET_BOTTOM})`
  )
  if (textarea && inputRow) {
    const above = textarea.top - inputRow.top
    const below = inputRow.bottom - textarea.bottom
    check(
      'single-line text vertically centred',
      Math.abs(above - below) <= 4,
      `${above}px above vs ${below}px below inside .input-row`
    )
  }
}

// --- sidebar drawer ---
await page.click('.menu-btn').catch(() => {})
await page.waitForTimeout(400)
const sidebar = await box('.sidebar')
const footer = await box('.sidebar-footer')
const newChat = await box('.new-chat-btn')
if (sidebar) {
  // Should start at the very top and stop at the edge of the usable area —
  // running to VH would push its footer under the home indicator, and
  // overflow:hidden would then clip the buttons.
  const usableBottom = VH - INSET_BOTTOM
  check(
    'drawer covers the usable area exactly',
    sidebar.top === 0 && Math.abs(sidebar.bottom - usableBottom) <= 2,
    `top=${sidebar.top} bottom=${sidebar.bottom} (expected ~${usableBottom}, screen ${VH})`
  )
}
if (footer && newChat) {
  const btnGap = VH - newChat.bottom
  check('New chat button clear of home indicator', btnGap >= INSET_BOTTOM,
    `New chat bottom is ${btnGap}px from screen bottom (need >= ${INSET_BOTTOM})`)
  check('footer not clipped', footer.bottom <= VH, `footer bottom=${footer.bottom} screen=${VH}`)
}

let failed = 0
for (const r of report) {
  if (!r.ok) failed++
  console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}\n          ${r.detail}`)
}
console.log(`\n${report.length - failed}/${report.length} checks passed`)

await page.screenshot({ path: '/tmp/pwa-chat.png' })
await browser.close()
process.exit(failed ? 1 : 0)
