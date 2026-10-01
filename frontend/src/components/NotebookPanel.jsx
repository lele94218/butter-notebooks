import { useState, useEffect, useRef } from 'react'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import './NotebookPanel.css'


// Make sure the browser holds a valid Jupyter session, then let the iframe ride
// on the cookie. The token must not go in the iframe URL: nginx logs query
// strings, and this token grants arbitrary code execution.
async function ensureJupyterSession(baseUrl, token) {
  // Already signed in? Nothing to do. This check is the whole point: asking for
  // the login page while a session exists returns a redirect with no form in
  // it, so the _xsrf field came back empty and the POST was rejected with 403.
  const probe = await fetch(`${baseUrl}api/status`, { credentials: 'include' })
  if (probe.ok) return

  // Otherwise log in the way Jupyter's own form does: read _xsrf from the page,
  // post it with the token in the body. The matching cookie is scoped to
  // /jupyter/, so the browser attaches it to this request on its own.
  const page = await fetch(`${baseUrl}login`, { credentials: 'include' })
  const html = await page.text()
  const xsrf = (html.match(/name="_xsrf"[^>]*value="([^"]+)"/) || [])[1]
  if (!xsrf) throw new Error('could not read _xsrf from the Jupyter login page')

  const res = await fetch(`${baseUrl}login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _xsrf: xsrf, password: token }),
    redirect: 'manual',
  })
  // Success is a 302, which reads as an opaque 0 under redirect: 'manual'.
  if (res.status >= 400) throw new Error(`Jupyter rejected the token (${res.status})`)

  const after = await fetch(`${baseUrl}api/status`, { credentials: 'include' })
  if (!after.ok) throw new Error(`Jupyter session not established (${after.status})`)
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
        await ensureJupyterSession(base_url, token)
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
