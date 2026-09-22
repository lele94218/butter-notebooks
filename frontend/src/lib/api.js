import { API_BASE, TOKEN_KEY } from './constants'

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
