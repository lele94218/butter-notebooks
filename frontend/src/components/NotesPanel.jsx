import { useState, useEffect, useMemo, useCallback, useContext } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import { ThemeContext } from '../lib/theme'
import { makeMdComponents, katexOptions } from './MdMessage'
import FileTree, { buildTree } from './FileTree'
import './NotesPanel.css'

export default function NotesPanel() {
  const theme = useContext(ThemeContext)
  const mdComponents = useMemo(() => makeMdComponents(theme), [theme])

  const [notes, setNotes] = useState([])
  const [selectedNote, setSelectedNote] = useState(() => localStorage.getItem('butter_last_note') || null)
  const [openDirs, setOpenDirs] = useState({})
  const [content, setContent] = useState('')
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

  const selectNote = (f) => {
    setSelectedNote(f)
    localStorage.setItem('butter_last_note', f)
    // On phones the tree is an overlay — close it once a note is picked.
    if (window.matchMedia('(max-width: 600px)').matches) setTreeOpen(false)
  }

  useEffect(() => {
    if (!selectedNote) return
    setLoading(true)
    fetch(`${API_BASE}/v1/notes/read?path=${encodeURIComponent(selectedNote)}`, { headers: headers() })
      .then(r => r.json())
      .then(d => setContent(d.content || ''))
      .catch(() => setContent('Failed to load note.'))
      .finally(() => setLoading(false))
  }, [selectedNote])

  return (
    <div className="notes-layout">
      {treeOpen && <div className="notes-tree-backdrop" onClick={() => setTreeOpen(false)} />}
      {treeOpen && (
        <div className="notes-filetree">
          <div className="notes-filetree-header">
            <span className="notes-filetree-title">Notes</span>
            <button className="notes-refresh-btn" onClick={refreshNotes} title="Refresh">&#8634;</button>
            <button className="notes-collapse-btn" onClick={() => setTreeOpen(false)} title="Collapse">&laquo;</button>
          </div>
          <div className="notes-filetree-list">
            <FileTree
              tree={buildTree(notes)}
              selectedNote={selectedNote}
              onSelect={selectNote}
              openDirs={openDirs}
              toggleDir={key => setOpenDirs(prev => ({ ...prev, [key]: prev[key] === false ? true : false }))}
            />
          </div>
        </div>
      )}

      <div className="note-panel">
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
          <div className="note-content">
            {loading ? (
              <p style={{ color: 'var(--text2)' }}>Loading...</p>
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
        )}
      </div>
    </div>
  )
}
