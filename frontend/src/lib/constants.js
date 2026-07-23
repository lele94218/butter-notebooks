export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8765'
export const TOKEN_KEY = 'butter_auth_token'

export const MODELS = [
  { id: 'claude-fable-5',            label: 'Fable 5' },
  { id: 'claude-opus-4-8',           label: 'Opus 4.8' },
  { id: 'claude-opus-4-7',           label: 'Opus 4.7' },
  { id: 'claude-opus-4-6',           label: 'Opus 4.6' },
  { id: 'claude-sonnet-5',           label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]
export const DEFAULT_MODEL = 'claude-opus-4-8'
