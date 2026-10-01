import { useState, useEffect, useRef } from 'react'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import './NotebookPanel.css'


// Log in to Jupyter the way its own form does: fetch the login page for the
// _xsrf cookie, then POST the token in the body. Same origin, so the cookie it
// sets is the one the iframe will use.
async function jupyterLogin(baseUrl, token) {
  const page = await fetch(`${baseUrl}login`, { credentials: 'include' })
  const html = await page.text()
  const xsrf =
    (html.match(/name="_xsrf"\s+value="([^"]+)"/) || [])[1] ||
    (document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/) || [])[1] ||
    ''
  const body = new URLSearchParams({ _xsrf: xsrf, password: token })
  const res = await fetch(`${baseUrl}login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  })
  // 302 is the success path; an opaque redirect reads as 0 to fetch.
  if (res.status >= 400) throw new Error(`Jupyter login failed (${res.status})`)
}

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
        // Exchange the token for Jupyter's session cookie before the iframe
        // loads. Putting it in the iframe URL (?token=…) worked, but nginx logs
        // query strings in full, so every visit wrote a credential that grants
        // arbitrary code execution into the access log.
        await jupyterLogin(base_url, token)
        setState({ status: 'ready', url: `${base_url}lab`, error: null })
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
