import { useState, useEffect } from 'react'

// Small corner stamp: build id + the safe-area insets actually in effect.
// Makes it obvious whether a device picked up the latest deploy (service
// workers can keep serving an old shell) and what iOS reported for the insets.
export default function BuildBadge() {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState(null)

  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement)
      setInfo({
        top: cs.getPropertyValue('--sa-top').trim() || '—',
        bottom: cs.getPropertyValue('--sa-bottom').trim() || '—',
        standalone:
          window.matchMedia('(display-mode: standalone)').matches ||
          window.navigator.standalone === true,
        screenH: window.screen?.height,
        innerH: window.innerHeight,
        dpr: window.devicePixelRatio,
        // Rendered height of the drawer — if this exceeds the usable area the
        // footer gets clipped by overflow:hidden.
        sidebarH: Math.round(
          document.querySelector('.sidebar')?.getBoundingClientRect().height || 0
        ),
      })
    }
    read()
    const t = setTimeout(read, 1500)
    return () => clearTimeout(t)
  }, [])

  if (!info) return null
  return (
    <button className="build-badge" onClick={() => setOpen(o => !o)} title="Build info">
      {open ? (
        <span className="build-badge-detail">
          {__BUILD_ID__} · {info.standalone ? 'app' : 'web'} ·{' '}
          scr{info.screenH}/in{info.innerH}@{info.dpr}x · h{info.sidebarH}
        </span>
      ) : (
        // Insets are shown by default: they're the thing that keeps going
        // wrong, and having to tap to see them slowed every diagnosis down.
        <span>
          {__BUILD_ID__} · sa↓{info.bottom} ↑{info.top}
        </span>
      )}
    </button>
  )
}
