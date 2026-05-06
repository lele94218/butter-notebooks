import { useState } from 'react'
import { API_BASE, TOKEN_KEY } from '../lib/constants'
import './LoginScreen.css'

export default function LoginScreen({ onAuth }) {
  const [input, setInput] = useState(import.meta.env.VITE_API_TOKEN || '')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    const token = input.trim()
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/health`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) {
        localStorage.setItem(TOKEN_KEY, token)
        onAuth()
      } else {
        setError('Invalid token')
      }
    } catch {
      setError('Cannot reach server')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-box">
        <h1>butter notebooks</h1>
        <p>Enter your access token</p>
        <form onSubmit={submit}>
          <input
            type="password"
            className="login-input"
            placeholder="Token"
            value={input}
            onChange={e => setInput(e.target.value)}
            autoFocus
          />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-btn" disabled={!input.trim() || loading}>
            {loading ? '...' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  )
}
