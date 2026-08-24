import { useState } from 'react'

// One-line summary of a tool's input for the collapsed header.
function toolSummary(input) {
  if (!input || typeof input !== 'object') return ''
  const first =
    input.command ?? input.file_path ?? input.path ?? input.pattern ??
    input.url ?? input.query ?? input.description
  if (typeof first === 'string') return first
  try { return JSON.stringify(input) } catch { return '' }
}

function fmtInput(input) {
  if (input == null) return ''
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) } catch { return String(input) }
}

export default function ToolCard({ tool }) {
  const [open, setOpen] = useState(false)
  const summary = toolSummary(tool.input)
  const state = tool.running ? 'running' : tool.is_error ? 'error' : 'done'
  return (
    <div className={`tool-card tool-card--${state}`}>
      <button className="tool-head" onClick={() => setOpen(o => !o)} type="button">
        <span className={`tool-dot tool-dot--${state}`} />
        <span className="tool-name">{tool.name || 'tool'}</span>
        {summary ? <span className="tool-summary">{summary}</span> : null}
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section-label">input</div>
          <pre className="tool-pre">{fmtInput(tool.input)}</pre>
          {tool.result != null && (
            <>
              <div className="tool-section-label">{tool.is_error ? 'error' : 'result'}</div>
              <pre className="tool-pre">{tool.result || '(empty)'}</pre>
            </>
          )}
          {tool.running && <div className="tool-running">running…</div>}
        </div>
      )}
    </div>
  )
}
