import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8765'
const API_TOKEN = import.meta.env.VITE_API_TOKEN || ''

const headers = () => ({ Authorization: `Bearer ${API_TOKEN}` })

const mdComponents = {
  code({ inline, className, children }) {
    if (inline) return <code>{children}</code>
    return <pre><code className={className}>{children}</code></pre>
  }
}

function MdMessage({ text, streaming }) {
  return (
    <div className="msg-body">
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="cursor" />}
    </div>
  )
}

// ── Chat panel ─────────────────────────────────────────────
function ChatPanel({ sessionId, onSessionId }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setLoading(true)
    setStatus('thinking…')
    textareaRef.current.style.height = 'auto'

    const userMsg = { role: 'user', text }
    const assistantMsg = { role: 'assistant', text: '', streaming: true }
    setMessages(prev => [...prev, userMsg, assistantMsg])

    try {
      const res = await fetch(`${API_BASE}/v1/chat`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, session_id: sessionId }),
      })

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
          if (payload === '[DONE]') continue
          try {
            const data = JSON.parse(payload)
            if (data.type === 'session') {
              onSessionId(data.session_id)
            } else if (data.type === 'delta') {
              setMessages(prev => {
                const msgs = [...prev]
                msgs[msgs.length - 1] = {
                  ...msgs[msgs.length - 1],
                  text: msgs[msgs.length - 1].text + data.text,
                }
                return msgs
              })
              setStatus('')
            } else if (data.type === 'done') {
              setMessages(prev => {
                const msgs = [...prev]
                msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
                return msgs
              })
            } else if (data.type === 'error') {
              setStatus(`error: ${data.text}`)
            }
          } catch {}
        }
      }
    } catch (e) {
      setStatus(`error: ${e.message}`)
    } finally {
      setLoading(false)
      setStatus('')
    }
  }, [input, loading, sessionId, onSessionId])

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const onInput = (e) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'
  }

  return (
    <div className="chat-panel">
      <div className="chat-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <h2>butter notebooks</h2>
            <p>Chat with Claude. Files stay on your Mac mini.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            {msg.role === 'assistant'
              ? <MdMessage text={msg.text} streaming={msg.streaming} />
              : <div className="msg-body">{msg.text}</div>
            }
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="input-area">
        <div className="input-inner">
          <div className="input-row">
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Message…"
              value={input}
              onChange={onInput}
              onKeyDown={onKeyDown}
            />
            <button className="send-btn" onClick={send} disabled={!input.trim() || loading}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="status-bar">{status}</div>
    </div>
  )
}

// ── Notes panel ────────────────────────────────────────────
function NotesPanel({ selectedNote, onSelectNote }) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!selectedNote) return
    setLoading(true)
    fetch(`${API_BASE}/v1/notes/read?path=${encodeURIComponent(selectedNote)}`, { headers: headers() })
      .then(r => r.json())
      .then(d => setContent(d.content || ''))
      .catch(() => setContent('Failed to load note.'))
      .finally(() => setLoading(false))
  }, [selectedNote])

  if (!selectedNote) {
    return (
      <div className="note-panel">
        <div className="empty-state">
          <h2>No note selected</h2>
          <p>Pick a file from the sidebar</p>
        </div>
      </div>
    )
  }

  return (
    <div className="note-panel">
      <div className="note-content">
        {loading ? (
          <p style={{ color: 'var(--text2)' }}>Loading…</p>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={mdComponents}
          >
            {content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  )
}

// ── App ────────────────────────────────────────────────────
export default function App() {
  const [notes, setNotes] = useState([])
  const [selectedNote, setSelectedNote] = useState(null)
  const [sessionId, setSessionId] = useState(null)
  const [tab, setTab] = useState('chat') // 'chat' | 'notes'

  useEffect(() => {
    fetch(`${API_BASE}/v1/notes`, { headers: headers() })
      .then(r => r.json())
      .then(d => setNotes(d.files || []))
      .catch(() => {})
  }, [])

  const newChat = () => {
    setSessionId(null)
    setTab('chat')
  }

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">butter notebooks</div>
        <div className="notes-list">
          {notes.map(f => (
            <div
              key={f}
              className={`note-item ${selectedNote === f ? 'active' : ''}`}
              title={f}
              onClick={() => { setSelectedNote(f); setTab('notes') }}
            >
              {f.split('/').pop()}
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <button className="new-chat-btn" onClick={newChat}>+ New chat</button>
        </div>
      </div>

      {/* Main */}
      <div className="main">
        <div className="tab-bar">
          <div className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>Chat</div>
          <div className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>Note</div>
        </div>

        {tab === 'chat'
          ? <ChatPanel sessionId={sessionId} onSessionId={setSessionId} />
          : <NotesPanel selectedNote={selectedNote} onSelectNote={setSelectedNote} />
        }
      </div>
    </div>
  )
}
