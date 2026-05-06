import { useState, useRef, useEffect, useCallback, useContext } from 'react'
import MonacoEditor from '@monaco-editor/react'
import { initVimMode } from 'monaco-vim'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import { ThemeContext } from '../lib/theme'
import './CodePanel.css'

export default function CodePanel() {
  const theme = useContext(ThemeContext)
  const [entries, setEntries] = useState([])
  const [dirPath, setDirPath] = useState(() => localStorage.getItem('butter_code_dir') || '')
  const [openFile, setOpenFile] = useState(null)
  const [code, setCode] = useState('')
  const [output, setOutput] = useState([])
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [vimMode, setVimMode] = useState(false)
  const [outputHeight, setOutputHeight] = useState(200)
  const [filetreeOpen, setFiletreeOpen] = useState(true)
  const sessionId = useRef('code-' + Math.random().toString(36).slice(2))
  const vimRef = useRef(null)
  const editorRef = useRef(null)
  const saveFileRef = useRef(null)

  const onResizeStart = useCallback((e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = outputHeight
    const onMove = (ev) => {
      const delta = startY - ev.clientY
      setOutputHeight(Math.max(60, Math.min(600, startH + delta)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [outputHeight])

  const loadDir = useCallback((path) => {
    fetch(`${API_BASE}/v1/files?path=${encodeURIComponent(path)}`, { headers: headers() })
      .then(r => r.json())
      .then(d => { setEntries(d.entries || []); setDirPath(path); localStorage.setItem('butter_code_dir', path) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const savedDir = localStorage.getItem('butter_code_dir') || ''
    loadDir(savedDir)
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
  saveFileRef.current = saveFile

  const runCode = async () => {
    setRunning(true)
    setOutput([])
    const t0 = performance.now()
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
    setOutput(prev => [...prev, { type: 'meta', text: `── done (${((performance.now() - t0) / 1000).toFixed(2)}s) ──\n` }])
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
      {filetreeOpen && (
        <div className="code-filetree">
          <div className="code-filetree-header">
            {dirPath && <button className="code-up-btn" onClick={goUp} title="Up">&#8249;</button>}
            <span className="code-dir-label">{dirPath || '/'}</span>
            <button className="code-refresh-btn" onClick={() => loadDir(dirPath)} title="Refresh">&#8634;</button>
            <button className="code-collapse-btn" onClick={() => setFiletreeOpen(false)} title="Collapse sidebar">&laquo;</button>
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
      )}

      <div className="code-main">
        <div className="code-toolbar">
          {!filetreeOpen && (
            <button className="code-btn code-expand-btn" onClick={() => setFiletreeOpen(true)} title="Show file tree">&raquo;</button>
          )}
          <span className="code-filename">{openFile ? openFile.path : '---'}</span>
          <button className="code-btn code-run-btn" onClick={runCode} disabled={running}>
            {running ? '⏳' : '▶ Run'}
          </button>
          <button className="code-btn code-save-btn" onClick={saveFile} disabled={!openFile || saving}>
            {saving ? '...' : '💾 Save'}
          </button>
          <button className="code-btn code-reset-btn" onClick={resetKernel} title="Reset kernel (clear variables)">
            &#8634; Reset
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
            theme={theme === 'dark' ? 'vs-dark' : 'vs'}
            value={code}
            onChange={v => setCode(v || '')}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              editor.addCommand(
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                () => saveFileRef.current?.()
              )
            }}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              lineNumbers: 'on',
              tabSize: 4,
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              acceptSuggestionOnCommitCharacter: false,
              wordBasedSuggestions: 'off',
              parameterHints: { enabled: false },
            }}
          />
        </div>

        <div className="code-resize-handle" onMouseDown={onResizeStart} />
        <div className="code-output" style={{ height: outputHeight }}>
          {output.length === 0 && !running && (
            <span className="code-output-empty">Run code to see output</span>
          )}
          {output.map((ev, i) => {
            if (ev.type === 'image') {
              return <img key={i} src={`data:image/png;base64,${ev.data}`} className="code-output-img" alt="plot" />
            }
            return (
              <pre key={i} className={`code-output-text ${ev.type === 'stderr' ? 'code-output-err' : ''} ${ev.type === 'meta' ? 'code-output-meta' : ''}`}>
                {ev.text}
              </pre>
            )
          })}
        </div>
      </div>
    </div>
  )
}
