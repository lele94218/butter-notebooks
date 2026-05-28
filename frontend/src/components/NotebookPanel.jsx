import { useState, useEffect, useRef } from 'react'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import './NotebookPanel.css'

export default function NotebookPanel() {
  const [state, setState] = useState({ status: 'loading', url: null, error: null })
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/v1/jupyter-token`, { headers: headers() })
        if (!res.ok) {
          const t = await res.text()
          setState({ status: 'error', url: null, error: `${res.status}: ${t}` })
          return
        }
        const { token, base_url } = await res.json()
        const url = `${base_url}lab?token=${token}`
        setState({ status: 'ready', url, error: null })
      } catch (e) {
        setState({ status: 'error', url: null, error: e.message })
      }
    })()
  }, [])

  if (state.status === 'loading') {
    return <div className="notebook-panel notebook-loading">Connecting to Jupyter...</div>
  }

  if (state.status === 'error') {
    return (
      <div className="notebook-panel notebook-error">
        <p>Failed to connect to Jupyter</p>
        <code>{state.error}</code>
      </div>
    )
  }

  return (
    <div className="notebook-panel">
      {!iframeLoaded && (
        <div className="notebook-progress-wrap">
          <div className="notebook-progress-text">Loading Jupyter Notebook...</div>
          <div className="notebook-progress-track">
            <div className="notebook-progress-bar" />
          </div>
        </div>
      )}
      <iframe
        src={state.url}
        className={`notebook-iframe${iframeLoaded ? '' : ' notebook-iframe--hidden'}`}
        title="Jupyter Notebook"
        allow="clipboard-read; clipboard-write"
        onLoad={() => setIframeLoaded(true)}
      />
    </div>
  )
}
