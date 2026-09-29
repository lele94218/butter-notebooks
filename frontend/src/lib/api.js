import { API_BASE, TOKEN_KEY } from './constants'

// Accept the token via ?t= once, then strip it from the URL. Lets automated
// layout checks (scripts/check-mobile.mjs, the iOS Simulator) reach the real UI
// instead of stopping at the login screen. The token is the same credential the
// login form takes, so this grants nothing extra.
;(() => {
  try {
    const u = new URL(window.location.href)
    const t = u.searchParams.get('t')
    if (t) {
      localStorage.setItem(TOKEN_KEY, t)
      u.searchParams.delete('t')
      window.history.replaceState({}, '', u.toString())
    }
  } catch {}
})()

export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
export const headers = () => ({ Authorization: `Bearer ${getToken()}` })

export async function fetchConversations() {
  const res = await fetch(`${API_BASE}/v1/conversations`, { headers: headers() })
  if (!res.ok) return []
  const d = await res.json()
  return d.conversations || []
}

export async function fetchConversation(id) {
  const res = await fetch(`${API_BASE}/v1/conversations/${id}`, { headers: headers() })
  if (!res.ok) return null
  const d = await res.json()
  return d.conversation || null
}

export async function apiGenerateTitle(id) {
  const res = await fetch(`${API_BASE}/v1/conversations/${id}/generate-title`, {
    method: 'POST',
    headers: headers(),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
  const d = await res.json()
  return d.title
}

export async function apiDeleteConv(id) {
  await fetch(`${API_BASE}/v1/conversations/${id}`, {
    method: 'DELETE',
    headers: headers(),
  })
}
