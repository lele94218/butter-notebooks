import { useState, useEffect, useRef, useCallback } from 'react'
// Static ?url import: it resolves to a string at build time, so only the URL is
// in the bundle — the worker file itself is still fetched on demand. A dynamic
// import of the same specifier doesn't give back the URL under Vite.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './PdfView.css'

// Pages are drawn as they come into view, and released when they fall well out
// of it, so a 100-page lecture deck doesn't rasterise up front.
const RENDER_MARGIN = '600px'
const MAX_DPR = 2

let pdfjsPromise = null
function loadPdfjs() {
  // Imported on demand — pdf.js is large and most sessions never open a PDF.
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import('pdfjs-dist')
      lib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      return lib
    })()
  }
  return pdfjsPromise
}

export default function PdfView({ data, title }) {
  const [doc, setDoc] = useState(null)
  const [error, setError] = useState('')
  const [pageSize, setPageSize] = useState(null)   // unscaled size of page 1
  const [width, setWidth] = useState(0)
  const roRef = useRef(null)

  // A callback ref, not useEffect: the scroller only mounts once the document
  // has loaded, so an effect with [] deps ran while it was still null, left the
  // width at 0, and every page rendered at scale 1 — wider than the screen.
  const hostRef = useCallback((node) => {
    roRef.current?.disconnect()
    if (!node) return
    setWidth(Math.round(node.getBoundingClientRect().width))
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    ro.observe(node)
    roRef.current = ro
  }, [])

  useEffect(() => {
    let cancelled = false
    // Tear down via the loading task: in pdf.js 6 the document proxy has no
    // destroy() of its own, and calling one crashed the whole pane when
    // switching away from an open PDF.
    let task = null
    setDoc(null)
    setPageSize(null)
    setError('')
    ;(async () => {
      try {
        const pdfjs = await loadPdfjs()
        // The buffer is transferred to the worker, so hand over a copy —
        // otherwise a re-render finds it detached.
        task = pdfjs.getDocument({ data: data.slice(0) })
        const loaded = await task.promise
        if (cancelled) return
        const first = await loaded.getPage(1)
        const vp = first.getViewport({ scale: 1 })
        if (cancelled) return
        setPageSize({ w: vp.width, h: vp.height })
        setDoc(loaded)
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e))
      }
    })()
    return () => { cancelled = true; task?.destroy() }
  }, [data])

  useEffect(() => () => roRef.current?.disconnect(), [])

  if (error) return <div className="pdfview-msg pdfview-msg--error">Couldn’t open this PDF: {error}</div>
  if (!doc || !pageSize) return <div className="pdfview-msg">Loading PDF…</div>

  // Until the width is known, don't guess — rendering at scale 1 produces pages
  // far wider than a phone screen.
  const scale = width ? (width - 24) / pageSize.w : 0
  return (
    <div className="pdfview" ref={hostRef}>
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage
          key={i + 1}
          doc={doc}
          number={i + 1}
          width={Math.max(1, Math.round(pageSize.w * scale))}
          height={Math.max(1, Math.round(pageSize.h * scale))}
          scale={scale}
        />
      ))}
      <div className="pdfview-end">{title} · {doc.numPages} pages</div>
    </div>
  )
}

function PdfPage({ doc, number, width, height, scale }) {
  const ref = useRef(null)
  const canvasRef = useRef(null)
  const taskRef = useRef(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => setVisible(e.isIntersecting),
      { root: null, rootMargin: RENDER_MARGIN }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const draw = useCallback(async () => {
    if (!scale) return
    taskRef.current?.cancel()
    // getPage rejects once the document is torn down — which happens whenever
    // the reader switches files mid-render — so the whole thing is guarded,
    // not just the render promise.
    try {
      const page = await doc.getPage(number)
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
      const viewport = page.getViewport({ scale: scale * dpr })
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport })
      taskRef.current = task
      await task.promise
    } catch { /* cancelled by a scroll, a resize, or switching note */ }
  }, [doc, number, scale])

  useEffect(() => {
    if (visible) draw()
    return () => taskRef.current?.cancel()
  }, [visible, draw])

  return (
    <div className="pdfview-page" ref={ref} style={{ width, height }}>
      {visible && <canvas ref={canvasRef} style={{ width, height }} />}
      <span className="pdfview-num">{number}</span>
    </div>
  )
}
