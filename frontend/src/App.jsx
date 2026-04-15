import { useState, useRef, useEffect, useCallback, useMemo, createContext, useContext } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import './App.css'

const ThemeContext = createContext('dark')

const THEME_COLORS = { dark: '#2f2e2b', light: '#f5f3ee' }
function applyThemeColor(theme) {
  let meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta) }
  meta.content = THEME_COLORS[theme] || THEME_COLORS.dark
}

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8765'
const TOKEN_KEY = 'butter_auth_token'

const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
const headers = () => ({ Authorization: `Bearer ${getToken()}` })
// VITE_API_TOKEN is only used to pre-fill the login input in dev — never auto-stores

// ── Login screen ───────────────────────────────────────────
function LoginScreen({ onAuth }) {
  const [input, setInput] = useState(import.meta.env.VITE_API_TOKEN || '')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    const token = input.trim()
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/health`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) {
        localStorage.setItem(TOKEN_KEY, token)
        onAuth()
      } else {
        setError('Invalid token')
      }
    } catch {
      setError('Cannot reach server')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-box">
        <h1>butter notebooks</h1>
        <p>Enter your access token</p>
        <form onSubmit={submit}>
          <input
            type="password"
            className="login-input"
            placeholder="Token"
            value={input}
            onChange={e => setInput(e.target.value)}
            autoFocus
          />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-btn" disabled={!input.trim() || loading}>
            {loading ? '…' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Conversation API helpers ───────────────────────────────
async function fetchConversations() {
  const res = await fetch(`${API_BASE}/v1/conversations`, { headers: headers() })
  if (!res.ok) return []
  const d = await res.json()
  return d.conversations || []
}

async function apiUpsertConv(conv) {
  await fetch(`${API_BASE}/v1/conversations/${conv.id}`, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(conv),
  })
}

async function apiDeleteConv(id) {
  await fetch(`${API_BASE}/v1/conversations/${id}`, {
    method: 'DELETE',
    headers: headers(),
  })
}

// ── Markdown renderer ──────────────────────────────────────
function makeMdComponents(theme) {
  const base = theme === 'dark' ? oneDark : oneLight
  const codeStyle = {
    ...base,
    'pre[class*="language-"]': {
      ...base['pre[class*="language-"]'],
      background: theme === 'dark' ? 'hsl(60 2.6% 7.6%)' : 'hsl(220 14% 96%)',
      borderRadius: '10px',
      border: theme === 'dark'
        ? '0.5px solid hsl(51 16.5% 84.5% / 12%)'
        : '0.5px solid hsl(220 14% 88%)',
      padding: '14px 16px',
      margin: 0,
      fontSize: '12.5px',
    },
    'code[class*="language-"]': {
      ...base['code[class*="language-"]'],
      fontSize: '12.5px',
      fontFamily: '"Anthropic Mono", ui-monospace, Consolas, monospace',
      background: 'none',
    },
  }
  return {
    code({ className, children }) {
      const match = /language-(\w+)/.exec(className || '')
      const isBlock = !!match || String(children).includes('\n')
      if (!isBlock) return <code>{children}</code>
      const lang = match ? match[1] : ''
      return (
        <SyntaxHighlighter
          style={codeStyle}
          language={lang || 'text'}
          PreTag="div"
          customStyle={{ margin: 0 }}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      )
    },
    table({ children }) {
      return <div className="table-scroll"><table>{children}</table></div>
    },
  }
}

const katexOptions = { throwOnError: false, strict: false }

function MdMessage({ text, streaming }) {
  const theme = useContext(ThemeContext)
  const mdComponents = useMemo(() => makeMdComponents(theme), [theme])
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, katexOptions]]}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

// ── Chat panel ─────────────────────────────────────────────
function ChatPanel({ sessionId, onSessionId, convId, initialMessages, onSaveConversation }) {
  const [messages, setMessages] = useState(initialMessages || [])
  const messagesRef = useRef(messages)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  // Keep ref in sync so done handler can read latest messages without stale closure
  useEffect(() => { messagesRef.current = messages }, [messages])

  // Sync when switching conversations
  useEffect(() => {
    setMessages(initialMessages || [])
  }, [initialMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setLoading(true)
    setStatus('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    const userMsg = { role: 'user', text }
    const assistantMsg = { role: 'assistant', text: '', streaming: true }

    setMessages(prev => {
      const next = [...prev, userMsg, assistantMsg]
      return next
    })

    try {
      const res = await fetch(`${API_BASE}/v1/chat`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, session_id: sessionId }),
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let newSessionId = sessionId

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
              newSessionId = data.session_id
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
              if (data.session_id) {
                newSessionId = data.session_id
                onSessionId(data.session_id)
              }
              // Build final messages (streaming: false) directly — don't read from ref
              // which is still stale at this point (React hasn't re-rendered yet)
              const finalMsgs = messagesRef.current.map((m, i) =>
                i === messagesRef.current.length - 1 ? { ...m, streaming: false } : m
              )
              setMessages(finalMsgs)
              onSaveConversation(finalMsgs, newSessionId, text, convId)
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
  }, [input, loading, sessionId, onSessionId, onSaveConversation])

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
              ? msg.text === '' && msg.streaming
                ? <div className="thinking-dots"><span/><span/><span/></div>
                : <MdMessage text={msg.text} streaming={msg.streaming} />
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

// ── File tree helpers ──────────────────────────────────────
function buildTree(paths) {
  const root = {}
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || { __dir: true, __children: {} }
      node = node[parts[i]].__children
    }
    node[parts[parts.length - 1]] = { __dir: false, __path: p }
  }
  return root
}

const IconFolderOpen = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0}}>
    <path d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6l1.5 1.5H13.5A1 1 0 0 1 14.5 5V12.5A1 1 0 0 1 13.5 13.5H2.5A1 1 0 0 1 1.5 12.5V3.5Z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
    <path d="M1.5 6.5H14.5L13 12.5H3L1.5 6.5Z" fill="currentColor" fillOpacity="0.35" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round"/>
  </svg>
)

const IconFolderClosed = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0}}>
    <path d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6l1.5 1.5H13.5A1 1 0 0 1 14.5 5V12.5A1 1 0 0 1 13.5 13.5H2.5A1 1 0 0 1 1.5 12.5V3.5Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
  </svg>
)

const IconFile = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0}}>
    <path d="M3.5 1.5H9.5L12.5 4.5V14.5A0.5 0.5 0 0 1 12 15H4A0.5 0.5 0 0 1 3.5 14.5V1.5Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
    <path d="M9.5 1.5V4.5H12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M5.5 7.5H10.5M5.5 9.5H10.5M5.5 11.5H8.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round"/>
  </svg>
)

function FileTree({ tree, depth = 0, selectedNote, onSelect, openDirs, toggleDir }) {
  return (
    <>
      {Object.entries(tree)
        .sort(([a, av], [b, bv]) => {
          if (av.__dir !== bv.__dir) return av.__dir ? -1 : 1
          return a.localeCompare(b)
        })
        .map(([name, node]) => {
          if (node.__dir) {
            const key = name + depth
            const open = openDirs[key] !== false
            return (
              <div key={key}>
                <div
                  className="tree-dir"
                  style={{ paddingLeft: 8 + depth * 14 + 'px' }}
                  onClick={() => toggleDir(key)}
                >
                  <span className="tree-arrow">{open ? '▾' : '▸'}</span>
                  {open ? <IconFolderOpen /> : <IconFolderClosed />}
                  <span className="tree-dir-name">{name}</span>
                </div>
                {open && (
                  <FileTree
                    tree={node.__children}
                    depth={depth + 1}
                    selectedNote={selectedNote}
                    onSelect={onSelect}
                    openDirs={openDirs}
                    toggleDir={toggleDir}
                  />
                )}
              </div>
            )
          }
          return (
            <div
              key={node.__path}
              className={`note-item tree-file ${selectedNote === node.__path ? 'active' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 + 'px' }}
              title={node.__path}
              onClick={() => onSelect(node.__path)}
            >
              <IconFile />
              <span>{name.replace(/\.md$/, '')}</span>
            </div>
          )
        })}
    </>
  )
}

// ── Notes panel ────────────────────────────────────────────
function NotesPanel({ selectedNote }) {
  const theme = useContext(ThemeContext)
  const mdComponents = useMemo(() => makeMdComponents(theme), [theme])
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
          <div className="prose">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[[rehypeKatex, katexOptions]]}
              components={mdComponents}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

// ── App ────────────────────────────────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken())
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('butter_theme') || 'dark'
    document.documentElement.dataset.theme = saved
    applyThemeColor(saved)
    return saved
  })
  const toggleTheme = () => setTheme(t => {
    const next = t === 'dark' ? 'light' : 'dark'
    localStorage.setItem('butter_theme', next)
    document.documentElement.dataset.theme = next
    applyThemeColor(next)
    return next
  })

  // iOS keyboard: shrink app height to visual viewport when keyboard appears
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--keyboard-offset', `${offset}px`)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])

  const [notes, setNotes] = useState([])
  const [selectedNote, setSelectedNote] = useState(null)
  const [openDirs, setOpenDirs] = useState({})
  const [sessionId, setSessionId] = useState(null)   // Claude session_id — for --resume only
  const [convId, setConvId] = useState(null)          // our stable conversation UUID
  const [tab, setTab] = useState('chat')
  const [sidebarTab, setSidebarTab] = useState('chats') // 'chats' | 'notes'
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Conversation history
  const [conversations, setConversations] = useState([])
  const [activeConvId, setActiveConvId] = useState(null)
  const [activeMessages, setActiveMessages] = useState([])

  const refreshNotes = useCallback(() => {
    fetch(`${API_BASE}/v1/notes`, { headers: headers() })
      .then(r => r.json())
      .then(d => setNotes(d.files || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshNotes()
    fetchConversations().then(setConversations)
  }, [])

  const newChat = () => {
    setSessionId(null)
    setConvId(null)
    setActiveConvId(null)
    setActiveMessages([])
    setTab('chat')
  }

  const loadConversation = (conv) => {
    setSessionId(conv.sessionId)   // Claude session_id for --resume
    setConvId(conv.id)             // our stable UUID
    setActiveConvId(conv.id)
    setActiveMessages(conv.messages)
    setTab('chat')
  }

  const handleSaveConversation = useCallback((messages, claudeSid, firstUserMsg, stableConvId) => {
    // stableConvId: our UUID (null if first message in new chat)
    const id = stableConvId || claudeSid  // first message: use claudeSid as initial id
    setConversations(prev => {
      const existingIdx = prev.findIndex(c => c.id === id)
      const title = existingIdx >= 0
        ? prev[existingIdx].title
        : (firstUserMsg ? firstUserMsg.slice(0, 48) + (firstUserMsg.length > 48 ? '…' : '') : 'New conversation')
      // Keep our stable id, update sessionId to latest claude session_id for --resume
      const conv = { id, title, messages, sessionId: claudeSid, updatedAt: Date.now() }
      apiUpsertConv(conv)
      let next
      if (existingIdx >= 0) {
        next = [...prev]
        next[existingIdx] = conv
      } else {
        next = [conv, ...prev]
      }
      if (next.length > 100) next = next.slice(0, 100)
      return next
    })
    setConvId(id)
    setActiveConvId(id)
    setActiveMessages(messages)
  }, [])

  const deleteConversation = (e, id) => {
    e.stopPropagation()
    apiDeleteConv(id) // fire-and-forget
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeConvId === id) newChat()
  }

  if (!authed) return <LoginScreen onAuth={() => setAuthed(true)} />

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY)
    setAuthed(false)
  }

  return (
    <ThemeContext.Provider value={theme}>
    <div className="app" data-theme={theme}>
      {/* Mobile overlay backdrop */}
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar-header">
          <span>butter notebooks</span>
          <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)}>✕</button>
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${sidebarTab === 'chats' ? 'active' : ''}`}
              onClick={() => setSidebarTab('chats')}
            >Chats</button>
            <button
              className={`sidebar-tab ${sidebarTab === 'notes' ? 'active' : ''}`}
              onClick={() => setSidebarTab('notes')}
            >Notes</button>
            {sidebarTab === 'notes' && (
              <button className="refresh-notes-btn" onClick={refreshNotes} title="Refresh notes">↺</button>
            )}
          </div>
        </div>

        <div className="notes-list">
          {sidebarTab === 'chats' ? (
            conversations.length === 0 ? (
              <div className="sidebar-empty">No saved chats yet</div>
            ) : (
              conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`note-item conv-item ${activeConvId === conv.id ? 'active' : ''}`}
                  onClick={() => { loadConversation(conv); setSidebarOpen(false) }}
                  title={conv.title}
                >
                  <span className="conv-title">{conv.title}</span>
                  <button
                    className="conv-delete"
                    onClick={(e) => deleteConversation(e, conv.id)}
                    title="Delete"
                  >×</button>
                </div>
              ))
            )
          ) : (
            <FileTree
              tree={buildTree(notes)}
              selectedNote={selectedNote}
              onSelect={f => { setSelectedNote(f); setTab('notes'); setSidebarOpen(false) }}
              openDirs={openDirs}
              toggleDir={key => setOpenDirs(prev => ({ ...prev, [key]: prev[key] === false ? true : false }))}
            />
          )}
        </div>

        <div className="sidebar-footer">
          <button className="new-chat-btn" onClick={newChat}>+ New chat</button>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button className="theme-toggle" onClick={logout} title="Log out">⏏</button>
        </div>
      </div>

      {/* Main */}
      <div className="main">
        <div className="tab-bar">
          <button className="menu-btn" onClick={() => setSidebarOpen(o => !o)}>☰</button>
          <div className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>Chat</div>
          <div className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>Notes</div>
        </div>

        {tab === 'chat'
          ? <ChatPanel
              key={activeConvId || 'new'}
              sessionId={sessionId}
              onSessionId={setSessionId}
              convId={convId}
              initialMessages={activeMessages}
              onSaveConversation={handleSaveConversation}
            />
          : <NotesPanel selectedNote={selectedNote} />
        }
      </div>
    </div>
    </ThemeContext.Provider>
  )
}
