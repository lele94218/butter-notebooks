import { useState, useEffect, useMemo, useCallback, useContext } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import { ThemeContext } from '../lib/theme'
import { makeMdComponents, makeCodeStyle, katexOptions } from './MdMessage'
import CodeBlock from './CodeBlock'
import FileTree, { buildTree, ancestorsOf } from './FileTree'
import './NotesPanel.css'

const TREE_MIN = 160
const TREE_MAX = 480

export default function NotesPanel() {
  const theme = useContext(ThemeContext)
  const mdComponents = useMemo(() => makeMdComponents(theme), [theme])
  const codeStyle = useMemo(() => makeCodeStyle(theme), [theme])

  const [notes, setNotes] = useState([])
  const [selectedNote, setSelectedNote] = useState(() => localStorage.getItem('butter_last_note') || null)
  // Pane width, dragged by the handle on its right edge and remembered. Set as
  // a custom property rather than an inline width so the phone media query
  // (which turns the tree into a drawer) still wins.
  const [treeWidth, setTreeWidth] = useState(() => {
    const v = parseInt(localStorage.getItem('butter_tree_width') || '', 10)
    return Number.isFinite(v) ? Math.min(TREE_MAX, Math.max(TREE_MIN, v)) : 200
  })
  useEffect(() => {
    try { localStorage.setItem('butter_tree_width', String(treeWidth)) } catch {}
  }, [treeWidth])

  const startResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = e.currentTarget.parentElement.getBoundingClientRect().width
    const move = ev => setTreeWidth(
      Math.min(TREE_MAX, Math.max(TREE_MIN, Math.round(startW + ev.clientX - startX)))
    )
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.classList.remove('is-resizing')
    }
    document.body.classList.add('is-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }, [])

  // Open/closed per directory path, remembered across reloads. Absent means
  // closed (see FileTree), so a fresh vault opens tidy.
  const [openDirs, setOpenDirs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('butter_open_dirs') || '{}') } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem('butter_open_dirs', JSON.stringify(openDirs)) } catch {}
  }, [openDirs])
  // { kind: 'markdown' | 'text' | 'pdf', content, language, truncated, url }
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(false)
  // On phones the tree is an overlay drawer, so start collapsed (content first).
  const [treeOpen, setTreeOpen] = useState(
    () => !window.matchMedia('(max-width: 600px)').matches
  )

  const refreshNotes = useCallback(() => {
    fetch(`${API_BASE}/v1/notes`, { headers: headers() })
      .then(r => r.json())
      .then(d => setNotes(d.files || []))
      .catch(() => {})
  }, [])

  useEffect(() => { refreshNotes() }, [])

  const revealPath = useCallback((f) => {
    const anc = ancestorsOf(f)
    if (!anc.length) return
    setOpenDirs(prev => {
      const next = { ...prev }
      for (const d of anc) next[d] = true
      return next
    })
  }, [])

  // Keep the restored file visible — otherwise it sits inside folders that are
  // now closed by default and the tree looks empty of it.
  useEffect(() => { if (selectedNote) revealPath(selectedNote) }, [])

  const selectNote = (f) => {
    setSelectedNote(f)
    revealPath(f)
    localStorage.setItem('butter_last_note', f)
    // On phones the tree is an overlay — close it once a note is picked.
    if (window.matchMedia('(max-width: 600px)').matches) setTreeOpen(false)
  }

  useEffect(() => {
    if (!selectedNote) return
    let cancelled = false
    let objectUrl = null
    setLoading(true)
    ;(async () => {
      try {
        const q = encodeURIComponent(selectedNote)
        if (/\.pdf$/i.test(selectedNote)) {
          // The viewer needs the file itself. Fetched as a blob so the token
          // travels in a header rather than in the <iframe> URL.
          const res = await fetch(`${API_BASE}/v1/notes/file?path=${q}`, { headers: headers() })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          objectUrl = URL.createObjectURL(await res.blob())
          if (!cancelled) setDoc({ kind: 'pdf', url: objectUrl })
          return
        }
        const res = await fetch(`${API_BASE}/v1/notes/read?path=${q}`, { headers: headers() })
        const d = await res.json()
        if (!res.ok) throw new Error(d.detail || `HTTP ${res.status}`)
        if (!cancelled) setDoc({ kind: d.kind || 'markdown', content: d.content || '', language: d.language, truncated: d.truncated })
      } catch (e) {
        if (!cancelled) setDoc({ kind: 'error', content: `Failed to load: ${e.message}` })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [selectedNote])

  return (
    <div className="notes-layout">
      {treeOpen && <div className="notes-tree-backdrop" onClick={() => setTreeOpen(false)} />}
      {treeOpen && (
        <div className="notes-filetree" style={{ '--tree-w': `${treeWidth}px` }}>
          <div className="notes-filetree-header">
            <span className="notes-filetree-title">Notes</span>
            <button className="notes-refresh-btn" onClick={refreshNotes} title="Refresh">&#8634;</button>
            <button className="notes-collapse-btn" onClick={() => setTreeOpen(false)} title="Collapse">&laquo;</button>
          </div>
          <div
            className="notes-filetree-resizer"
            onPointerDown={startResize}
            onDoubleClick={() => setTreeWidth(200)}
            title="Drag to resize · double-click to reset"
          />
          <div className="notes-filetree-list">
            <FileTree
              tree={buildTree(notes)}
              selectedNote={selectedNote}
              onSelect={selectNote}
              openDirs={openDirs}
              toggleDir={key => setOpenDirs(prev => ({ ...prev, [key]: !prev[key] }))}
            />
          </div>
        </div>
      )}

      <div className={`note-panel ${doc?.kind === 'pdf' ? 'note-panel--pdf' : ''}`}>
        {!treeOpen && (
          <button className="notes-expand-btn" onClick={() => setTreeOpen(true)} title="Show file tree">
            <span className="notes-expand-icon">&#9776;</span>
            <span className="notes-expand-text">Files</span>
          </button>
        )}
        {!selectedNote ? (
          <div className="empty-state">
            <h2>No note selected</h2>
            <p>Pick a file from the tree</p>
          </div>
        ) : (
          <div className={`note-content ${doc?.kind === 'pdf' ? 'note-content--pdf' : ''}`}>
            {loading ? (
              <p style={{ color: 'var(--text2)' }}>Loading...</p>
            ) : doc?.kind === 'pdf' ? (
              <iframe className="note-pdf" src={doc.url} title={selectedNote} />
            ) : doc?.kind === 'text' ? (
              <div className="prose">
                {doc.truncated && (
                  <p className="note-truncated">Showing the first 2 MB of this file.</p>
                )}
                <CodeBlock lang={doc.language} codeStyle={codeStyle}>{doc.content}</CodeBlock>
              </div>
            ) : (
              <div className="prose">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[[rehypeKatex, katexOptions]]}
                  components={mdComponents}
                >
                  {doc?.content || ''}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
