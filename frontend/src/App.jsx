import { useState, useRef, useEffect, useCallback, useMemo, createContext, useContext } from 'react'
import MonacoEditor from '@monaco-editor/react'
import { initVimMode } from 'monaco-vim'
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

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6',   label: 'Opus 4.6' },
  { id: 'claude-opus-4-7',   label: 'Opus 4.7' },
]
const DEFAULT_MODEL = 'claude-sonnet-4-6'

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
function ChatPanel({ sessionId, onSessionId, convId, initialMessages, onSaveConversation, model, onModelChange }) {
  const [messages, setMessages] = useState(initialMessages || [])
  const messagesRef = useRef(messages)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [attachments, setAttachments] = useState([])   // [{id, path, mime, url, preview, uploading, error}]
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)

  // Upload one File object; returns the backend response {path, mime, url}.
  const uploadFile = useCallback(async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/v1/upload`, {
      method: 'POST',
      headers: headers(),
      body: fd,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`upload failed (${res.status}) ${t}`)
    }
    return await res.json()
  }, [])

  const addFiles = useCallback(async (files) => {
    const list = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'))
    if (list.length === 0) return
    const staged = list.map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      preview: URL.createObjectURL(f),
      mime: f.type,
      uploading: true,
      error: null,
    }))
    setAttachments(prev => [...prev, ...staged])
    setStatus('uploading image…')
    for (const s of staged) {
      try {
        const r = await uploadFile(s.file)
        setAttachments(prev => prev.map(a => a.id === s.id
          ? { ...a, uploading: false, path: r.path, url: r.url, mime: r.mime }
          : a))
      } catch (e) {
        setAttachments(prev => prev.map(a => a.id === s.id
          ? { ...a, uploading: false, error: e.message }
          : a))
        setStatus(`error: ${e.message}`)
      }
    }
    // Clear status if no outstanding errors/uploads.
    setAttachments(prev => {
      if (!prev.some(a => a.uploading || a.error)) setStatus('')
      return prev
    })
  }, [uploadFile])

  const removeAttachment = useCallback((id) => {
    setAttachments(prev => {
      const found = prev.find(a => a.id === id)
      if (found && found.preview) { try { URL.revokeObjectURL(found.preview) } catch {} }
      return prev.filter(a => a.id !== id)
    })
  }, [])

  const onPaste = useCallback((e) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files = []
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f && f.type && f.type.startsWith('image/')) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  const onPickFiles = useCallback((e) => {
    const files = e.target.files
    if (files && files.length) addFiles(files)
    // reset so picking the same file twice still fires change
    e.target.value = ''
  }, [addFiles])

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
    // Must have text OR images; all uploads must have completed cleanly.
    const hasImages = attachments.length > 0
    if ((!text && !hasImages) || loading) return
    if (attachments.some(a => a.uploading)) {
      setStatus('waiting for upload to finish…')
      return
    }
    if (attachments.some(a => a.error || !a.path)) {
      setStatus('error: some images failed to upload; remove them before sending')
      return
    }

    const imagesPayload = attachments.map(a => ({ path: a.path, mime: a.mime }))
    // Snapshot for message history UI: keep url so we can render the thumbnails.
    const imagesForMsg = attachments.map(a => ({
      path: a.path, mime: a.mime, url: a.url,
    }))

    setInput('')
    setAttachments([])
    setLoading(true)
    setStatus('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    const userMsg = { role: 'user', text, ...(imagesForMsg.length ? { images: imagesForMsg } : {}) }
    const assistantMsg = { role: 'assistant', text: '', thinking: '', streaming: true }

    setMessages(prev => {
      const next = [...prev, userMsg, assistantMsg]
      return next
    })

    try {
      const res = await fetch(`${API_BASE}/v1/chat`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          session_id: sessionId,
          conv_id: convId,
          model,
          ...(imagesPayload.length ? { images: imagesPayload } : {}),
        }),
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
            } else if (data.type === 'thinking') {
              setMessages(prev => {
                const msgs = [...prev]
                msgs[msgs.length - 1] = {
                  ...msgs[msgs.length - 1],
                  thinking: (msgs[msgs.length - 1].thinking || '') + data.text,
                }
                return msgs
              })
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
              // Use functional setState to get correct accumulated state —
              // messagesRef may be stale if React batched all delta setStates together
              setMessages(prev => {
                const finalMsgs = prev.map((m, i) =>
                  i === prev.length - 1 ? { ...m, streaming: false } : m
                )
                onSaveConversation(finalMsgs, newSessionId, text, convId)
                return finalMsgs
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
  }, [input, loading, sessionId, convId, model, onSessionId, onSaveConversation, attachments])

  const [sidCopied, setSidCopied] = useState(false)
  const copySid = useCallback(() => {
    if (!sessionId) return
    try {
      navigator.clipboard?.writeText(sessionId)
      setSidCopied(true)
      setTimeout(() => setSidCopied(false), 1200)
    } catch {}
  }, [sessionId])

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
      <div className="chat-topbar">
        <select
          className="model-select"
          value={model || DEFAULT_MODEL}
          onChange={e => onModelChange(e.target.value)}
          disabled={loading}
          title="Claude model"
        >
          {MODELS.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <span
          className={`sid-pill${sidCopied ? ' sid-pill--copied' : ''}`}
          title={sessionId ? `session: ${sessionId} (click to copy)` : 'no session yet'}
          onClick={copySid}
        >
          {sidCopied ? 'copied!' : `sid: ${sessionId ? sessionId.slice(0, 8) : '—'}`}
        </span>
      </div>
      <div className="chat-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <h2>butter notebooks</h2>
            <p>Chat with Claude. Files stay on your Mac mini.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            {msg.role === 'assistant' ? (
              <div className="msg-assistant">
                {msg.thinking ? <div className="msg-thinking">{msg.thinking}</div> : null}
                {msg.text === '' && msg.streaming
                  ? <div className="thinking-dots"><span/><span/><span/></div>
                  : msg.text === '' && !msg.streaming && !msg.thinking
                    ? <div className="msg-empty">（无回复）</div>
                    : msg.text
                      ? <MdMessage text={msg.text} streaming={msg.streaming} />
                      : null
                }
              </div>
            ) : (
              <div className="msg-user-wrap">
                {msg.images && msg.images.length > 0 && (
                  <div className="msg-images">
                    {msg.images.map((im, j) => {
                      const src = im.url
                        ? `${API_BASE}${im.url}?t=${encodeURIComponent(getToken())}`
                        : null
                      if (!src) return null
                      return <img key={j} src={src} className="msg-image" alt="attached" />
                    })}
                  </div>
                )}
                {msg.text ? <div className="msg-body">{msg.text}</div> : null}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="input-area">
        <div className="input-inner">
          {attachments.length > 0 && (
            <div className="attach-strip">
              {attachments.map(a => (
                <div key={a.id} className={`attach-thumb ${a.uploading ? 'uploading' : ''} ${a.error ? 'error' : ''}`}>
                  <img src={a.preview} alt="" />
                  {a.uploading && <div className="attach-spinner" />}
                  {a.error && <div className="attach-err" title={a.error}>!</div>}
                  <button
                    type="button"
                    className="attach-remove"
                    onClick={() => removeAttachment(a.id)}
                    aria-label="Remove"
                  >×</button>
                </div>
              ))}
            </div>
          )}
          <div className="input-row">
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              title="Attach image"
              aria-label="Attach image"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={onPickFiles}
            />
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Message…"
              value={input}
              onChange={onInput}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <button
              className="send-btn"
              onClick={send}
              disabled={(!input.trim() && attachments.length === 0) || loading || attachments.some(a => a.uploading || a.error)}
            >
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

// ── Code Panel ─────────────────────────────────────────────
function CodePanel() {
  const theme = useContext(ThemeContext)
  const [entries, setEntries] = useState([])
  const [dirPath, setDirPath] = useState(() => localStorage.getItem('butter_code_dir') || '')
  const [openFile, setOpenFile] = useState(null)   // { path, name }
  const [code, setCode] = useState('')
  const [output, setOutput] = useState([])          // [{type, text/data}]
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [vimMode, setVimMode] = useState(false)
  const sessionId = useRef('code-' + Math.random().toString(36).slice(2))
  const vimRef = useRef(null)
  const editorRef = useRef(null)

  const loadDir = useCallback((path) => {
    fetch(`${API_BASE}/v1/files?path=${encodeURIComponent(path)}`, { headers: headers() })
      .then(r => r.json())
      .then(d => { setEntries(d.entries || []); setDirPath(path); localStorage.setItem('butter_code_dir', path) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const savedDir = localStorage.getItem('butter_code_dir') || ''
    loadDir(savedDir)
    // Re-open last file
    const savedFile = localStorage.getItem('butter_code_file')
    if (savedFile) {
      fetch(`${API_BASE}/v1/files/read?path=${encodeURIComponent(savedFile)}`, { headers: headers() })
        .then(r => r.json())
        .then(d => { setOpenFile({ path: savedFile, name: savedFile.split('/').pop() }); setCode(d.content || '') })
        .catch(() => {})
    }
  }, [])

  const openFileEntry = (entry) => {
    if (entry.is_dir) { loadDir(entry.path); return }
    fetch(`${API_BASE}/v1/files/read?path=${encodeURIComponent(entry.path)}`, { headers: headers() })
      .then(r => r.json())
      .then(d => { setOpenFile(entry); setCode(d.content || ''); setOutput([]); localStorage.setItem('butter_code_file', entry.path) })
  }

  const saveFile = async () => {
    if (!openFile) return
    setSaving(true)
    await fetch(`${API_BASE}/v1/files/write`, {
      method: 'PUT',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: openFile.path, content: code }),
    }).catch(() => {})
    setSaving(false)
  }

  const runCode = async () => {
    setRunning(true)
    setOutput([])
    try {
      const res = await fetch(`${API_BASE}/v1/execute`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, session_id: sessionId.current }),
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
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.type !== 'done') setOutput(prev => [...prev, ev])
          } catch {}
        }
      }
    } catch (e) {
      setOutput(prev => [...prev, { type: 'stderr', text: String(e) }])
    }
    setRunning(false)
  }

  const resetKernel = async () => {
    await fetch(`${API_BASE}/v1/kernel/reset?session_id=${sessionId.current}`, {
      method: 'POST', headers: headers(),
    })
    setOutput([{ type: 'stdout', text: '✓ Kernel reset\n' }])
  }

  const goUp = () => {
    const parts = dirPath.split('/').filter(Boolean)
    parts.pop()
    loadDir(parts.join('/'))
  }

  return (
    <div className="code-panel">
      {/* File tree */}
      <div className="code-filetree">
        <div className="code-filetree-header">
          {dirPath && <button className="code-up-btn" onClick={goUp} title="Up">‹</button>}
          <span className="code-dir-label">{dirPath || '/'}</span>
          <button className="code-refresh-btn" onClick={() => loadDir(dirPath)} title="Refresh">↺</button>
        </div>
        <div className="code-filetree-list">
          {entries.map(e => (
            <div
              key={e.path}
              className={`code-file-item ${openFile?.path === e.path ? 'active' : ''} ${e.is_dir ? 'is-dir' : ''}`}
              onClick={() => openFileEntry(e)}
            >
              <span className="code-file-icon">{e.is_dir ? '📁' : '📄'}</span>
              <span className="code-file-name">{e.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Editor + output */}
      <div className="code-main">
        <div className="code-toolbar">
          <span className="code-filename">{openFile ? openFile.path : '—'}</span>
          <button className="code-btn code-run-btn" onClick={runCode} disabled={running}>
            {running ? '⏳' : '▶ Run'}
          </button>
          <button className="code-btn code-save-btn" onClick={saveFile} disabled={!openFile || saving}>
            {saving ? '…' : '💾 Save'}
          </button>
          <button className="code-btn code-reset-btn" onClick={resetKernel} title="Reset kernel (clear variables)">
            ↺ Reset
          </button>
          <button
            className={`code-btn code-vim-btn ${vimMode ? 'active' : ''}`}
            onClick={() => {
              if (vimMode) {
                vimRef.current?.dispose()
                vimRef.current = null
                setVimMode(false)
              } else if (editorRef.current) {
                vimRef.current = initVimMode(editorRef.current)
                setVimMode(true)
              }
            }}
            title="Toggle Vim mode"
          >
            VIM
          </button>
        </div>

        <div className="code-editor-wrap">
          <MonacoEditor
            height="100%"
            language="python"
            theme={theme === 'dark' ? 'vs-dark' : 'light'}
            value={code}
            onChange={v => setCode(v || '')}
            onMount={editor => { editorRef.current = editor }}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              lineNumbers: 'on',
              tabSize: 4,
            }}
          />
        </div>

        <div className="code-output">
          {output.length === 0 && !running && (
            <span className="code-output-empty">Run code to see output</span>
          )}
          {output.map((ev, i) => {
            if (ev.type === 'image') {
              return <img key={i} src={`data:image/png;base64,${ev.data}`} className="code-output-img" alt="plot" />
            }
            return (
              <pre key={i} className={`code-output-text ${ev.type === 'stderr' ? 'code-output-err' : ''}`}>
                {ev.text}
              </pre>
            )
          })}
        </div>
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
  const [selectedNote, setSelectedNote] = useState(() => localStorage.getItem('butter_last_note') || null)
  const [openDirs, setOpenDirs] = useState({})
  const [sessionId, setSessionId] = useState(null)   // Claude session_id — for --resume only
  const [convId, setConvId] = useState(null)          // our stable conversation UUID
  const [model, setModel] = useState(DEFAULT_MODEL)   // per-conversation model
  const [tab, setTab] = useState(() => localStorage.getItem('butter_last_tab') || 'chat')
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
    setModel(DEFAULT_MODEL)
    setTab('chat')
  }

  const loadConversation = (conv) => {
    setSessionId(conv.sessionId)   // Claude session_id for --resume
    setConvId(conv.id)             // our stable UUID
    setActiveConvId(conv.id)
    setActiveMessages(conv.messages)
    setModel(conv.model || DEFAULT_MODEL)
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
      const prevModel = existingIdx >= 0 ? prev[existingIdx].model : null
      const conv = { id, title, messages, sessionId: claudeSid, updatedAt: Date.now(), model: model || prevModel || DEFAULT_MODEL }
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
  }, [model])

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
              onSelect={f => { setSelectedNote(f); localStorage.setItem('butter_last_note', f); setTab('notes'); localStorage.setItem('butter_last_tab', 'notes'); setSidebarOpen(false) }}
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
          <div className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => { setTab('chat'); localStorage.setItem('butter_last_tab', 'chat') }}>Chat</div>
          <div className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => { setTab('notes'); localStorage.setItem('butter_last_tab', 'notes') }}>Notes</div>
          <div className={`tab ${tab === 'code' ? 'active' : ''}`} onClick={() => { setTab('code'); localStorage.setItem('butter_last_tab', 'code') }}>Code</div>
        </div>

        {tab === 'chat'
          ? <ChatPanel
              key={activeConvId || 'new'}
              sessionId={sessionId}
              onSessionId={setSessionId}
              convId={convId}
              initialMessages={activeMessages}
              onSaveConversation={handleSaveConversation}
              model={model}
              onModelChange={setModel}
            />
          : tab === 'notes'
          ? <NotesPanel selectedNote={selectedNote} />
          : <CodePanel />
        }
      </div>
    </div>
    </ThemeContext.Provider>
  )
}
