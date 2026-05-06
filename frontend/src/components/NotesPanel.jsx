import { useState, useEffect, useMemo, useContext } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import { ThemeContext } from '../lib/theme'
import { makeMdComponents, katexOptions } from './MdMessage'
import './NotesPanel.css'

export default function NotesPanel({ selectedNote }) {
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
    </div>
  )
}
