import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import './ImageViewer.css'

const MAX_SCALE = 6
const DOUBLE_TAP_SCALE = 2.5
const DISMISS_DISTANCE = 110      // px of downward drag that closes the viewer
const TAP_SLOP = 10               // movement still counted as a tap, not a drag

// Full-screen image viewer. The app sets user-scalable=no, so native pinch
// zoom is unavailable and the gestures are implemented here: pinch and
// double-tap to zoom, drag to pan, swipe down to dismiss.
//
// Gesture state lives in a ref and is written straight to style.transform —
// running it through React state re-rendered on every touchmove and stuttered.
function Viewer({ src, alt, onClose }) {
  const imgRef = useRef(null)
  const [zoomed, setZoomed] = useState(false)
  const st = useRef({ s: 1, x: 0, y: 0 })
  const g = useRef({})
  const baseRef = useRef({ w: 0, h: 0 })
  // Browsers synthesise a dblclick from two quick taps. Without this the touch
  // double-tap zoomed in and the synthesised event immediately zoomed back out.
  const lastTouch = useRef(0)

  const apply = useCallback((withTransition) => {
    const el = imgRef.current
    if (!el) return
    const { s, x, y } = st.current
    el.style.transition = withTransition ? 'transform 0.22s ease' : 'none'
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`
  }, [])

  // Keep the image from being dragged off screen: at scale s it overflows the
  // viewport by half the difference on each axis.
  const clamp = useCallback(() => {
    const { w, h } = baseRef.current
    const s = st.current.s
    const maxX = Math.max(0, (w * s - window.innerWidth) / 2)
    const maxY = Math.max(0, (h * s - window.innerHeight) / 2)
    st.current.x = Math.min(maxX, Math.max(-maxX, st.current.x))
    st.current.y = Math.min(maxY, Math.max(-maxY, st.current.y))
  }, [])

  const setScale = useCallback((next, originX, originY, animate) => {
    const prev = st.current.s
    const s = Math.min(MAX_SCALE, Math.max(1, next))
    if (originX !== undefined) {
      // Anchor the zoom at the given point (viewport coords) so the pixel
      // under the fingers stays under the fingers.
      const cx = originX - window.innerWidth / 2
      const cy = originY - window.innerHeight / 2
      st.current.x = cx - (cx - st.current.x) * (s / prev)
      st.current.y = cy - (cy - st.current.y) * (s / prev)
    }
    st.current.s = s
    if (s === 1) { st.current.x = 0; st.current.y = 0 }
    clamp()
    apply(animate)
    setZoomed(s > 1)
  }, [apply, clamp])

  // Record the on-screen size at scale 1 so the pan limits are correct.
  const onLoad = useCallback((e) => {
    const r = e.currentTarget.getBoundingClientRect()
    baseRef.current = { w: r.width, h: r.height }
  }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dist = (t) => Math.hypot(
    t[0].clientX - t[1].clientX,
    t[0].clientY - t[1].clientY
  )

  const onTouchStart = (e) => {
    lastTouch.current = Date.now()
    const t = e.touches
    if (t.length === 2) {
      g.current = {
        mode: 'pinch',
        d0: dist(t),
        s0: st.current.s,
        mx: (t[0].clientX + t[1].clientX) / 2,
        my: (t[0].clientY + t[1].clientY) / 2,
      }
    } else if (t.length === 1) {
      const now = Date.now()
      const isDouble = g.current.lastTap && now - g.current.lastTap < 300
      g.current = {
        mode: st.current.s > 1 ? 'pan' : 'dismiss',
        x0: t[0].clientX, y0: t[0].clientY,
        tx0: st.current.x, ty0: st.current.y,
        moved: 0,
        lastTap: g.current.lastTap,
        startedAt: now,
      }
      if (isDouble) {
        g.current.mode = 'none'
        g.current.lastTap = 0
        setScale(st.current.s > 1 ? 1 : DOUBLE_TAP_SCALE, t[0].clientX, t[0].clientY, true)
      }
    }
  }

  const onTouchMove = (e) => {
    const t = e.touches
    const m = g.current
    if (m.mode === 'pinch' && t.length === 2) {
      e.preventDefault()
      setScale(m.s0 * (dist(t) / m.d0), m.mx, m.my, false)
    } else if (t.length === 1 && (m.mode === 'pan' || m.mode === 'dismiss')) {
      const dx = t[0].clientX - m.x0
      const dy = t[0].clientY - m.y0
      m.moved = Math.max(m.moved, Math.hypot(dx, dy))
      if (m.mode === 'pan') {
        e.preventDefault()
        st.current.x = m.tx0 + dx
        st.current.y = m.ty0 + dy
        clamp()
        apply(false)
      } else if (dy > 0) {
        // Unzoomed: dragging down peels the image away, fading as it goes.
        e.preventDefault()
        m.dy = dy
        const el = imgRef.current
        if (el) {
          el.style.transition = 'none'
          el.style.transform = `translate3d(0, ${dy}px, 0) scale(${Math.max(0.8, 1 - dy / 900)})`
          el.style.opacity = String(Math.max(0.25, 1 - dy / 500))
        }
      }
    }
  }

  const onTouchEnd = (e) => {
    lastTouch.current = Date.now()
    const m = g.current
    const lifted = e.touches.length === 0
    // A tap is a press that went nowhere. It has to be recognised while zoomed
    // too (mode 'pan'), otherwise double-tapping to zoom back out never fires.
    const tapped = lifted && m.moved <= TAP_SLOP && (m.mode === 'dismiss' || m.mode === 'pan')

    if (m.mode === 'dismiss') {
      if ((m.dy || 0) > DISMISS_DISTANCE) { onClose(); return }
      const el = imgRef.current
      if (el) {
        el.style.transition = 'transform 0.22s ease, opacity 0.22s ease'
        el.style.transform = 'translate3d(0,0,0) scale(1)'
        el.style.opacity = '1'
      }
      if (m.dy) st.current = { s: 1, x: 0, y: 0 }
    } else if (m.mode === 'pinch' && st.current.s <= 1.02) {
      setScale(1, undefined, undefined, true)
    }

    if (tapped) {
      g.current.lastTap = Date.now()
      const at = g.current.lastTap
      // Unzoomed, a lone tap dismisses — but only once it's clear no second tap
      // is coming. Zoomed in, a lone tap does nothing.
      if (m.mode === 'dismiss') {
        setTimeout(() => { if (g.current.lastTap === at) onClose() }, 310)
      }
    } else if (lifted) {
      g.current = { lastTap: g.current.lastTap }
    }
  }

  const onWheel = (e) => {
    e.preventDefault()
    setScale(st.current.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY, false)
  }

  return (
    <div
      className="imgview"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onWheel={onWheel}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt || ''}
        className="imgview-img"
        draggable={false}
        onLoad={onLoad}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onDoubleClick={(e) => {
          if (Date.now() - lastTouch.current < 800) return   // synthesised from a tap
          setScale(st.current.s > 1 ? 1 : DOUBLE_TAP_SCALE, e.clientX, e.clientY, true)
        }}
      />
      {/* Only on pointer devices: a phone closes by tapping or swiping down, and
          a corner button there would have to dodge the notch. */}
      <button className="imgview-close" onClick={onClose} aria-label="Close">{'✕'}</button>
      {zoomed && <div className="imgview-hint">{'双击还原'}</div>}
    </div>
  )
}

// Wraps an <img> so tapping it opens the full-size viewer.
export default function ZoomableImg({ src, className, alt, style }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <img
        src={src}
        className={className}
        alt={alt || ''}
        style={style}
        loading="lazy"
        onClick={() => setOpen(true)}
      />
      {open && createPortal(
        <Viewer src={src} alt={alt} onClose={() => setOpen(false)} />,
        document.body
      )}
    </>
  )
}
