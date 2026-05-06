import { createContext } from 'react'

export const ThemeContext = createContext('dark')

const THEME_COLORS = { dark: '#2f2e2b', light: '#f5f3ee' }

export function applyThemeColor(theme) {
  let meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta) }
  meta.content = THEME_COLORS[theme] || THEME_COLORS.dark
}
