import { useState, useRef, useEffect, useContext, useMemo, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import { ThemeContext } from '../lib/theme'
import { makeMdComponents, katexOptions } from './MdMessage'
import './AskPopover.css'

// A quick lookup should be quick. The chat tab's model choice is for long work
// and shouldn't drag this along with it.
export const ASK_DEFAULT_MODEL = 'gpt-6-astra'
const ASK_MODELS = [
  'gpt-6-astra',
  'gpt-6-astra-high',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]
const ASK_MODEL_KEY = 'butter_ask_model'

// One tap for the things asked most often. The label is what the button shows;
// the prompt is what actually gets sent.
const ASK_PRESETS = [
  { label: '费曼讲解', prompt: '用费曼学习法讲解这段:先用最朴素的话说清楚它在讲什么,指出其中容易混淆的地方,再用一个具体例子收尾。' },
  { label: '译为中文', prompt: '把这段翻译成中文。保留术语原文并在括号里标注,不要解释。' },
  { label: '要点', prompt: '用三到五个要点概括这段。' },
]

// Goes through the OpenAI-compatible endpoint on purpose: it runs the agent
// without a session and writes nothing, so asking about a line of a note
// doesn't leave a conversation behind.
async function* askStream({ quote, question, notePath, model, signal }) {
  const ask = question.trim() || 'Explain this.'
  const prompt =
    `From the note \`${notePath}\`:\n\n` +
    quote.split('\n').map(l => `> ${l}`).join('\n') +
    `\n\n${ask}\n\n` +
    `Answer briefly, about the quoted passage. Open the file if you need more context.`

  const res = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') return
      try {
        const piece = JSON.parse(payload).choices?.[0]?.delta?.content
        if (piece) yield piece
      } catch {}
    }
  }
}

export default function AskPopover({ quote, notePath, anchor, onClose }) {
  const theme = useContext(ThemeContext)
  const mdComponents = useMemo(() => makeMdComponents(theme), [theme])

  const [question, setQuestion] = useState('')
  const [model, setModel] = useState(
    () => localStorage.getItem(ASK_MODEL_KEY) || ASK_DEFAULT_MODEL
  )
  const [answer, setAnswer] = useState('')
  const [state, setState] = useState('idle')   // idle | running | done | error
  const [error, setError] = useState('')
  const abortRef = useRef(null)
  const inputRef = useRef(null)
  const boxRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { localStorage.setItem(ASK_MODEL_KEY, model) }, [model])

  // Escape closes; a click outside does too, unless a run is in flight — losing
  // a half-streamed answer to a stray click is worse than an extra keypress.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { abortRef.current?.abort(); onClose() } }
    const onDown = e => {
      if (state === 'running') return
      if (boxRef.current && !boxRef.current.contains(e.target)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose, state])

  useEffect(() => () => abortRef.current?.abort(), [])

  const run = useCallback(async (override) => {
    const ask = typeof override === 'string' ? override : question
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    setAnswer('')
    setError('')
    setState('running')
    try {
      for await (const piece of askStream({ quote, question: ask, notePath, model, signal: ctl.signal })) {
        setAnswer(prev => prev + piece)
      }
      setState('done')
    } catch (e) {
      if (e.name === 'AbortError') return
      setError(e.message)
      setState('error')
    }
  }, [quote, question, notePath, model])

  const onKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run() }
  }

  return (
    <div
      ref={boxRef}
      className="ask-pop"
      style={{
        top: anchor.top,
        left: anchor.left,
        // Bound by what's actually below the anchor, so a long answer scrolls
        // inside the box instead of running off the bottom of the screen.
        maxHeight: Math.max(240, window.innerHeight - anchor.top - 16),
      }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="ask-pop-quote">{quote}</div>

      <div className="ask-pop-row">
        <input
          ref={inputRef}
          className="ask-pop-input"
          placeholder="Ask about this… (Enter to send)"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {state === 'running' ? (
          <button className="ask-pop-btn" onClick={() => { abortRef.current?.abort(); setState('idle') }}>
            Stop
          </button>
        ) : (
          <button className="ask-pop-btn ask-pop-btn--go" onClick={run}>Ask</button>
        )}
      </div>

      <div className="ask-pop-foot">
        {ASK_PRESETS.map(p => (
          <button
            key={p.label}
            className="ask-pop-preset"
            onClick={() => { setQuestion(p.prompt); run(p.prompt) }}
            title={p.prompt}
          >{p.label}</button>
        ))}
        <span className="ask-pop-spacer" />
        <select className="ask-pop-model" value={model} onChange={e => setModel(e.target.value)}>
          {ASK_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <button className="ask-pop-close" onClick={() => { abortRef.current?.abort(); onClose() }}>✕</button>
      </div>

      {(answer || state === 'running' || state === 'error') && (
        <div className="ask-pop-answer prose">
          {state === 'error' ? (
            <p className="ask-pop-error">{error}</p>
          ) : answer ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[[rehypeKatex, katexOptions]]}
              components={mdComponents}
            >
              {answer}
            </ReactMarkdown>
          ) : (
            <p className="ask-pop-thinking">Thinking…</p>
          )}
        </div>
      )}
    </div>
  )
}
