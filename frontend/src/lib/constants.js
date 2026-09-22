export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8765'
export const TOKEN_KEY = 'butter_auth_token'

// Agents = CLI backends. Each owns its own models. Claude and codex sessions
// are not interchangeable, so a started conversation is locked to one agent
// (but models within the agent can still be switched).
export const AGENTS = [
  {
    id: 'claude', label: 'Claude',
    models: [
      { id: 'claude-opus-5',             label: 'Opus 5' },
      { id: 'claude-fable-5',            label: 'Fable 5' },
      { id: 'claude-opus-4-8',           label: 'Opus 4.8' },
      { id: 'claude-opus-4-7',           label: 'Opus 4.7' },
      { id: 'claude-opus-4-6',           label: 'Opus 4.6' },
      { id: 'claude-sonnet-5',           label: 'Sonnet 5' },
      { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
  },
  {
    id: 'codex', label: 'Codex',
    models: [
      { id: 'codex',           label: 'GPT-6 Astra' },
      { id: 'codex-high',      label: 'GPT-6 Astra high' },
      { id: 'codex-luna',      label: 'GPT-6 Luna' },
      { id: 'codex-luna-high', label: 'GPT-6 Luna high' },
    ],
  },
]

// Flat list kept for lookups / back-compat.
export const MODELS = AGENTS.flatMap(a => a.models)
export const DEFAULT_MODEL = 'claude-opus-5'

// Which agent (CLI backend) a model id belongs to.
export function modelBackend(id) {
  const a = AGENTS.find(a => a.models.some(m => m.id === id))
  return a ? a.id : 'claude'
}
export function agentModels(agentId) {
  return (AGENTS.find(a => a.id === agentId) || AGENTS[0]).models
}
export function defaultModelForAgent(agentId) {
  return agentModels(agentId)[0].id
}
