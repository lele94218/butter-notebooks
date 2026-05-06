export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8765'
export const TOKEN_KEY = 'butter_auth_token'

export const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6',   label: 'Opus 4.6' },
  { id: 'claude-opus-4-7',   label: 'Opus 4.7' },
]
export const DEFAULT_MODEL = 'claude-sonnet-4-6'
