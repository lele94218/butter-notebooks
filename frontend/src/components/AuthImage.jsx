import { useState, useEffect } from 'react'
import { API_BASE } from '../lib/constants'
import { headers } from '../lib/api'
import ZoomableImg from './ImageViewer'

export default function AuthImage({ url, className, alt }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    let blobUrl = null
    fetch(`${API_BASE}${url}`, { headers: headers() })
      .then(r => r.ok ? r.blob() : Promise.reject(r.status))
      .then(blob => {
        if (cancelled) return
        blobUrl = URL.createObjectURL(blob)
        setSrc(blobUrl)
      })
      .catch(() => { if (!cancelled) setSrc(null) })
    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [url])
  if (!src) return <div className={`${className || ''} msg-image--loading`} />
  return <ZoomableImg src={src} className={className} alt={alt} />
}
