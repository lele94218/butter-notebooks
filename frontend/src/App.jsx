import { useState, useEffect, useCallback } from 'react'
import { TOKEN_KEY, DEFAULT_MODEL } from './lib/constants'
import { getToken, fetchConversations, apiDeleteConv } from './lib/api'
import { ThemeContext, applyThemeColor } from './lib/theme'
import LoginScreen from './components/LoginScreen'
import ChatPanel from './components/ChatPanel'
import NotesPanel from './components/NotesPanel'
import CodePanel from './components/CodePanel'
import NotebookPanel from './components/NotebookPanel'
import BuildBadge from './components/BuildBadge'
import './App.css'

// The Code tab (Monaco editor + python kernel) is hidden for now — it sees
// little use. The panel and its backend routes are untouched; flip this to
// true to bring the tab back.
const SHOW_CODE_TAB = false

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

  useEffect(() => {
    // Publish the safe-area insets as --sa-top / --sa-bottom.
    //
    // env(safe-area-inset-*) can't be trusted here: WebKit reports 0 inside a
    // position:fixed subtree (body is fixed), and an early navigation can leave
    // the insets stuck at 0 for the document's lifetime. So read env() when it
    // gives something, and otherwise fall back to a known-good constant for the
    // device — a home-indicator iPhone in standalone always reserves 34pt at the
    // bottom, and screen vs. window height tells us the top band.
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;top:0;left:0;' +
      'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);'
    document.documentElement.appendChild(probe)

    const readInsets = () => {
      const cs = getComputedStyle(probe)
      let top = parseFloat(cs.paddingTop) || 0
      let bottom = parseFloat(cs.paddingBottom) || 0

      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true
      // When env() gives nothing in the installed app, assume the insets a
      // modern iPhone reserves. Deliberately unconditional: device sniffing
      // (screen height / DPR) was unreliable, and over-reserving on a device
      // without a home indicator costs a little padding, while under-reserving
      // puts buttons under the system gesture area.
      if (standalone) {
        if (!bottom) bottom = 34
        if (!top) top = 59
      }
      const root = document.documentElement.style
      root.setProperty('--sa-top', `${top}px`)
      root.setProperty('--sa-bottom', `${bottom}px`)
    }
    readInsets()
    // Insets can arrive late; re-read after the first frames settle.
    const t1 = setTimeout(readInsets, 300)
    const t2 = setTimeout(readInsets, 1200)
    window.addEventListener('orientationchange', readInsets)

    const cleanupInsets = () => {
      clearTimeout(t1); clearTimeout(t2)
      window.removeEventListener('orientationchange', readInsets)
      probe.remove()
    }

    const vv = window.visualViewport
    if (!vv) return cleanupInsets
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--keyboard-offset', `${offset}px`)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      cleanupInsets()
    }
  }, [])

  const [convId, setConvId] = useState(null)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [tab, setTab] = useState(() => {
    const saved = localStorage.getItem('butter_last_tab') || 'chat'
    // Don't restore into a tab that no longer has an entry point.
    if (saved === 'code' && !SHOW_CODE_TAB) return 'chat'
    return saved
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const [conversations, setConversations] = useState([])
  const [activeConvId, setActiveConvId] = useState(null)
  const [activeMessages, setActiveMessages] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)

  useEffect(() => {
    fetchConversations().then(list => {
      setConversations(list)
      // Restore the conversation that was open before a refresh, so an in-flight
      // run (its question + thinking indicator + live stream) is picked back up
      // by ChatPanel's pending/resume effect instead of landing on a blank chat.
      const saved = localStorage.getItem('butter_active_conv')
      if (!saved) return
      const conv = list.find(c => c.id === saved)
      if (conv) {
        setConvId(conv.id)
        setActiveConvId(conv.id)
        setActiveMessages(conv.messages)
        setActiveSessionId(conv.sessionId || null)
        setModel(conv.model || DEFAULT_MODEL)
      }
    })
  }, [])

  // Keep the sidebar "running" dots live: poll periodically and update only the
  // per-conversation running flag (never touch messages/order/titles).
  useEffect(() => {
    const poll = setInterval(async () => {
      const list = await fetchConversations()
      const runningIds = new Set(list.filter(c => c.running).map(c => c.id))
      setConversations(prev => prev.map(c => ({ ...c, running: runningIds.has(c.id) })))
    }, 4000)
    return () => clearInterval(poll)
  }, [])

  const newChat = () => {
    setConvId(null)
    setActiveConvId(null)
    setActiveMessages([])
    setActiveSessionId(null)
    setModel(DEFAULT_MODEL)
    setTab('chat')
    localStorage.removeItem('butter_active_conv')
  }

  const loadConversation = (conv) => {
    setConvId(conv.id)
    setActiveConvId(conv.id)
    setActiveMessages(conv.messages)
    setActiveSessionId(conv.sessionId || null)
    setModel(conv.model || DEFAULT_MODEL)
    setTab('chat')
    localStorage.setItem('butter_active_conv', conv.id)
    // Fresh base messages for an in-flight conversation are pulled inside
    // ChatPanel's pending/resume effect (avoids racing the live stream). #3
  }

  const handleSaveConversation = useCallback((messages, firstUserMsg, stableConvId) => {
    const id = stableConvId || crypto.randomUUID()
    setConversations(prev => {
      const existingIdx = prev.findIndex(c => c.id === id)
      const title = existingIdx >= 0
        ? prev[existingIdx].title
        : (firstUserMsg ? firstUserMsg.slice(0, 48) + (firstUserMsg.length > 48 ? '...' : '') : 'New conversation')
      const prevModel = existingIdx >= 0 ? prev[existingIdx].model : null
      const conv = { id, title, messages, updatedAt: Date.now(), model: model || prevModel || DEFAULT_MODEL }
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
    localStorage.setItem('butter_active_conv', id)
  }, [model])

  const renameConversation = useCallback((id, title) => {
    if (!id || !title) return
    setConversations(prev => prev.map(c => (c.id === id ? { ...c, title } : c)))
  }, [])

  const deleteConversation = (e, id) => {
    e.stopPropagation()
    apiDeleteConv(id)
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
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      <div className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''} ${sidebarCollapsed ? 'sidebar--collapsed' : ''}`}>
        <div className="sidebar-header">
          <span>butter notebooks</span>
          {/* Top-left: always visible, unlike the bottom edge which the home
              indicator can clip — which is exactly what it's here to diagnose. */}
          <BuildBadge />
          <button className="sidebar-collapse-btn" onClick={() => setSidebarCollapsed(c => !c)} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{sidebarCollapsed ? '»' : '«'}</button>
          <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)}>{'✕'}</button>
        </div>

        {/* Actions live at the TOP of the drawer. At the bottom they sat in the
            home-indicator band, where iOS's viewport quirks kept clipping them —
            no layout maths can fix an edge the system owns. */}
        <div className="sidebar-actions">
          <button className="new-chat-btn" onClick={newChat}>+ New chat</button>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button className="theme-toggle" onClick={logout} title="Log out">{'⏏'}</button>
        </div>

        <div className="notes-list">
          {conversations.length === 0 ? (
            <div className="sidebar-empty">No saved chats yet</div>
          ) : (
            conversations.map(conv => (
              <div
                key={conv.id}
                className={`note-item conv-item ${activeConvId === conv.id ? 'active' : ''}`}
                onClick={() => { loadConversation(conv); setSidebarOpen(false) }}
                title={conv.running ? `${conv.title} (running…)` : conv.title}
              >
                {conv.running && <span className="conv-running-dot" title="Running…" />}
                <span className="conv-title">{conv.title}</span>
                <button
                  className="conv-delete"
                  onClick={(e) => deleteConversation(e, conv.id)}
                  title="Delete"
                >{'×'}</button>
              </div>
            ))
          )}
        </div>

      </div>

      <div className="main">
        <div className="tab-bar">
          <button className="menu-btn" onClick={() => setSidebarOpen(o => !o)}>{'☰'}</button>
          <div className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => { setTab('chat'); localStorage.setItem('butter_last_tab', 'chat') }}>Chat</div>
          <div className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => { setTab('notes'); localStorage.setItem('butter_last_tab', 'notes') }}>Notes</div>
          {SHOW_CODE_TAB && (
            <div className={`tab ${tab === 'code' ? 'active' : ''}`} onClick={() => { setTab('code'); localStorage.setItem('butter_last_tab', 'code') }}>Code</div>
          )}
          <div className={`tab ${tab === 'notebook' ? 'active' : ''}`} onClick={() => { setTab('notebook'); localStorage.setItem('butter_last_tab', 'notebook') }}>Jupyter</div>
        </div>

        {tab === 'chat'
          ? <ChatPanel
              key={activeConvId || 'new'}
              convId={convId}
              initialSessionId={activeSessionId}
              initialMessages={activeMessages}
              onSaveConversation={handleSaveConversation}
              onRename={renameConversation}
              model={model}
              onModelChange={setModel}
            />
          : tab === 'notes'
          ? <NotesPanel />
          : tab === 'notebook'
          ? <NotebookPanel />
          : <CodePanel />
        }
      </div>
    </div>
    </ThemeContext.Provider>
  )
}
