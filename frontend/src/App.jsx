import { useState, useEffect, useCallback } from 'react'
import { TOKEN_KEY, API_BASE, DEFAULT_MODEL } from './lib/constants'
import { getToken, headers, fetchConversations, apiDeleteConv } from './lib/api'
import { ThemeContext, applyThemeColor } from './lib/theme'
import LoginScreen from './components/LoginScreen'
import ChatPanel from './components/ChatPanel'
import NotesPanel from './components/NotesPanel'
import CodePanel from './components/CodePanel'
import FileTree, { buildTree } from './components/FileTree'
import './App.css'

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
  const [convId, setConvId] = useState(null)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [tab, setTab] = useState(() => localStorage.getItem('butter_last_tab') || 'chat')
  const [sidebarTab, setSidebarTab] = useState('chats')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

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
    setConvId(null)
    setActiveConvId(null)
    setActiveMessages([])
    setModel(DEFAULT_MODEL)
    setTab('chat')
  }

  const loadConversation = (conv) => {
    setConvId(conv.id)
    setActiveConvId(conv.id)
    setActiveMessages(conv.messages)
    setModel(conv.model || DEFAULT_MODEL)
    setTab('chat')
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
  }, [model])

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
          <button className="sidebar-collapse-btn" onClick={() => setSidebarCollapsed(c => !c)} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{sidebarCollapsed ? '»' : '«'}</button>
          <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)}>{'✕'}</button>
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
              <button className="refresh-notes-btn" onClick={refreshNotes} title="Refresh notes">{'↺'}</button>
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
                  >{'×'}</button>
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
          <button className="theme-toggle" onClick={logout} title="Log out">{'⏏'}</button>
        </div>
      </div>

      <div className="main">
        <div className="tab-bar">
          <button className="menu-btn" onClick={() => setSidebarOpen(o => !o)}>{'☰'}</button>
          <div className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => { setTab('chat'); localStorage.setItem('butter_last_tab', 'chat') }}>Chat</div>
          <div className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => { setTab('notes'); localStorage.setItem('butter_last_tab', 'notes') }}>Notes</div>
          <div className={`tab ${tab === 'code' ? 'active' : ''}`} onClick={() => { setTab('code'); localStorage.setItem('butter_last_tab', 'code') }}>Code</div>
        </div>

        {tab === 'chat'
          ? <ChatPanel
              key={activeConvId || 'new'}
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
