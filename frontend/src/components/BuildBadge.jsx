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
          {__BUILD_ID__} · sa {info.bottom}/{info.top} ·{' '}
          {info.standalone ? 'app' : 'web'} · {info.screenH}/{info.innerH}@{info.dpr}x
        </span>
      ) : (
        <span>{__BUILD_ID__}</span>
      )}
    </button>
  )
}
