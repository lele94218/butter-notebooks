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

// Chromium can't emulate env(safe-area-inset-*), so inject the values iOS
// reports and force display-mode:standalone to match the installed app.
await page.addInitScript(
  ([top, bottom, token]) => {
    localStorage.setItem('butter_auth_token', token)
    const s = document.createElement('style')
    s.textContent = `:root{--sa-top:${top}px;--sa-bottom:${bottom}px}`
    document.documentElement.appendChild(s)
  },
  [INSET_TOP, INSET_BOTTOM, TOKEN]
)
await page.emulateMedia({ media: 'screen' })
await page.addInitScript(() => {
  const mm = window.matchMedia.bind(window)
  window.matchMedia = (q) =>
    q.includes('display-mode: standalone')
      ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }
      : mm(q)
})

await page.goto(URL, { waitUntil: 'networkidle' })
// Chromium reports env(safe-area-inset-*) as 0. The app reads the real insets
// at runtime into --sa-top / --sa-bottom, so set those to the iPhone values —
// this measures the site's own CSS the way iOS evaluates it.
await page.evaluate(
  ([top, bottom]) => {
    document.documentElement.style.setProperty('--sa-top', `${top}px`)
    document.documentElement.style.setProperty('--sa-bottom', `${bottom}px`)
  },
  [INSET_TOP, INSET_BOTTOM]
)
await page.waitForTimeout(600)

const box = async (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
  }, sel)

const report = []
const check = (name, ok, detail) => report.push({ name, ok, detail })

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
  check('drawer spans full height', sidebar.top === 0 && sidebar.bottom === VH,
    `top=${sidebar.top} bottom=${sidebar.bottom} (screen ${VH})`)
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
