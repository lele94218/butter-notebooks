// Capture the README screenshots.
//
//   node scripts/shots.mjs [url]
//
// Every API response is mocked with synthetic content, so the shots never
// contain real notes, conversations or hostnames.
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const URL = process.argv[2] || 'https://your-site.example.com'
const OUT = 'docs/screenshots'
mkdirSync(OUT, { recursive: true })

const ASSISTANT = `Softmax turns a vector of scores into a probability distribution:

$$\\sigma(z)_i = \\frac{e^{z_i}}{\\sum_{j=1}^{K} e^{z_j}}$$

Two properties matter in practice:

- every output is in $(0, 1)$ and they sum to $1$
- it is **shift-invariant** — $\\sigma(z + c) = \\sigma(z)$ for any constant $c$

That second one is why implementations subtract the max before exponentiating;
without it \`exp\` overflows on large logits.

\`\`\`python
def softmax(z, axis=-1):
    z = z - z.max(axis=axis, keepdims=True)   # shift for numerical stability
    e = np.exp(z)
    return e / e.sum(axis=axis, keepdims=True)
\`\`\`

The temperature variant divides the logits by $T$ first: $T < 1$ sharpens the
distribution, $T > 1$ flattens it toward uniform.`

const CONVERSATIONS = [
  {
    id: 'demo-1', title: 'Why softmax subtracts the max', model: 'claude-opus-5-5',
    sessionId: 'demo', running: false, updatedAt: Date.now(),
    messages: [
      { role: 'user', text: 'Why does every softmax implementation subtract the max first?' },
      { role: 'assistant', text: ASSISTANT },
    ],
  },
  { id: 'demo-2', title: 'Profiling the Vite build', model: 'claude-opus-5-5', sessionId: 'd', running: true, updatedAt: Date.now() - 6e5, messages: [] },
  { id: 'demo-3', title: 'SQLite WAL vs journal mode', model: 'codex', sessionId: 'd', running: false, updatedAt: Date.now() - 36e5, messages: [] },
  { id: 'demo-4', title: 'Plot the attention heatmap', model: 'claude-opus-5-5', sessionId: 'd', running: false, updatedAt: Date.now() - 72e5, messages: [] },
  { id: 'demo-5', title: 'Reverse proxy timeouts for SSE', model: 'codex', sessionId: 'd', running: false, updatedAt: Date.now() - 9e6, messages: [] },
  { id: 'demo-6', title: 'Gradient accumulation, step by step', model: 'claude-opus-5-5', sessionId: 'd', running: false, updatedAt: Date.now() - 12e6, messages: [] },
]

const NOTE = `# Attention

The scaled dot-product attention of a query against a set of keys and values:

$$\\text{Attention}(Q, K, V) = \\text{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V$$

## Why divide by $\\sqrt{d_k}$

For $q, k \\in \\mathbb{R}^{d_k}$ with independent unit-variance components, the dot
product $q \\cdot k$ has variance $d_k$. Without the scaling, large $d_k$ pushes the
logits into the saturated region of the softmax and the gradients vanish.

## Multi-head

Rather than one attention over $d_{\\text{model}}$ dimensions, run $h$ of them over
$d_k = d_{\\text{model}} / h$ each and concatenate:

$$\\text{MultiHead}(Q,K,V) = \\text{Concat}(\\text{head}_1, \\dots, \\text{head}_h)W^{O}$$

| Variant | Complexity | Notes |
| --- | --- | --- |
| Full | $O(n^2 d)$ | The baseline |
| Sliding window | $O(n w d)$ | Local context only |
| FlashAttention | $O(n^2 d)$ | Same cost, far fewer memory round-trips |
`

const FILES = [
  'Attention.md', 'Backpropagation.md', 'Linear Algebra.md',
  'papers/AlexNet.md', 'papers/Transformer.md', 'papers/ResNet.md',
  'reading/2026-week-11.md', 'reading/2026-week-12.md',
]

async function mocked(ctx) {
  await ctx.route('**/v1/conversations*', r =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversations: CONVERSATIONS }) }))
  await ctx.route('**/v1/notes?*', r =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ files: FILES }) }))
  await ctx.route('**/v1/notes', r =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ files: FILES }) }))
  await ctx.route('**/v1/notes/read*', r =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ path: 'Attention.md', content: NOTE }) }))
  await ctx.route('**/v1/chat/pending/**', r =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ pending: false }) }))
}

const browser = await chromium.launch()

async function shot(name, { width, height, mobile = false, prepare }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
  })
  await mocked(ctx)
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    localStorage.setItem('butter_auth_token', 'demo')
    localStorage.setItem('butter_active_conv', 'demo-1')
    localStorage.setItem('butter_theme', 'dark')
  })
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2200)
  if (prepare) await prepare(page)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  ${OUT}/${name}.png  ${width}x${height}`)
  await ctx.close()
}

await shot('chat', { width: 1280, height: 800 })
await shot('notes', {
  width: 1280, height: 800,
  prepare: async (p) => {
    await p.click('text=Notes')
    await p.waitForTimeout(900)
    await p.click('.tree-file >> nth=0').catch(() => {})
    await p.waitForTimeout(1200)
  },
})
await shot('mobile', { width: 393, height: 852, mobile: true })
await shot('mobile-sidebar', {
  width: 393, height: 852, mobile: true,
  prepare: async (p) => { await p.click('.menu-btn'); await p.waitForTimeout(600) },
})

await browser.close()
