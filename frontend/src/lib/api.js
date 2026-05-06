import { API_BASE, TOKEN_KEY } from './constants'

export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
export const headers = () => ({ Authorization: `Bearer ${getToken()}` })

export async function fetchConversations() {
  const res = await fetch(`${API_BASE}/v1/conversations`, { headers: headers() })
  if (!res.ok) return []
  const d = await res.json()
  return d.conversations || []
}

export async function apiDeleteConv(id) {
  await fetch(`${API_BASE}/v1/conversations/${id}`, {
    method: 'DELETE',
    headers: headers(),
  })
}
