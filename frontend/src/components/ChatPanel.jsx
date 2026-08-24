import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { API_BASE, MODELS, DEFAULT_MODEL } from '../lib/constants'
import { headers } from '../lib/api'
import MdMessage from './MdMessage'
import AuthImage from './AuthImage'
import ToolCard from './ToolCard'
import './ChatPanel.css'

const INITIAL_VISIBLE_MESSAGES = 20
const MESSAGES_PAGE_SIZE = 20

export default function ChatPanel({ convId, initialSessionId, initialMessages, onSaveConversation, model, onModelChange }) {
  const [messages, setMessages] = useState(initialMessages || [])
  const messagesRef = useRef(messages)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [attachments, setAttachments] = useState([])
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [sessionId, setSessionId] = useState(initialSessionId || null)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const chatAreaRef = useRef(null)
  const prevScrollHeightRef = useRef(null)

  const uploadFile = useCallback(async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/v1/upload`, {
      method: 'POST',
      headers: headers(),
      body: fd,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`upload failed (${res.status}) ${t}`)
    }
    return await res.json()
  }, [])

  const addFiles = useCallback(async (files) => {
    const list = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'))
    if (list.length === 0) return
    const staged = list.map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      preview: URL.createObjectURL(f),
      mime: f.type,
      uploading: true,
      error: null,
    }))
    setAttachments(prev => [...prev, ...staged])
    setStatus('uploading image...')
    for (const s of staged) {
      try {
        const r = await uploadFile(s.file)
        setAttachments(prev => prev.map(a => a.id === s.id
          ? { ...a, uploading: false, path: r.path, url: r.url, mime: r.mime }
          : a))
      } catch (e) {
        setAttachments(prev => prev.map(a => a.id === s.id
          ? { ...a, uploading: false, error: e.message }
          : a))
        setStatus(`error: ${e.message}`)
      }
    }
    setAttachments(prev => {
      if (!prev.some(a => a.uploading || a.error)) setStatus('')
      return prev
    })
  }, [uploadFile])

  const removeAttachment = useCallback((id) => {
    setAttachments(prev => {
      const found = prev.find(a => a.id === id)
      if (found && found.preview) { try { URL.revokeObjectURL(found.preview) } catch {} }
      return prev.filter(a => a.id !== id)
    })
  }, [])

  const onPaste = useCallback((e) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files = []
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f && f.type && f.type.startsWith('image/')) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  const onPickFiles = useCallback((e) => {
    const files = e.target.files
    if (files && files.length) addFiles(files)
    e.target.value = ''
  }, [addFiles])

  useEffect(() => { messagesRef.current = messages }, [messages])

  useEffect(() => {
    setMessages(initialMessages || [])
    setVisibleCount(INITIAL_VISIBLE_MESSAGES)
  }, [initialMessages])

  const processStream = useCallback(async (reader, { onDone } = {}) => {
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload === '[DONE]') continue
        try {
          const data = JSON.parse(payload)
          if (data.type === 'session') {
            if (data.session_id) setSessionId(data.session_id)
          } else if (data.type === 'thinking') {
            setMessages(prev => {
              const msgs = [...prev]
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                thinking: (msgs[msgs.length - 1].thinking || '') + data.text,
              }
              return msgs
            })
          } else if (data.type === 'tool_use') {
            setMessages(prev => {
              const msgs = [...prev]
              const last = { ...msgs[msgs.length - 1] }
              last.tools = [
                ...(last.tools || []),
                { id: data.id, name: data.name, input: data.input, running: true },
              ]
              msgs[msgs.length - 1] = last
              return msgs
            })
          } else if (data.type === 'tool_result') {
            setMessages(prev => {
              const msgs = [...prev]
              const last = { ...msgs[msgs.length - 1] }
              last.tools = (last.tools || []).map(t =>
                t.id === data.tool_use_id
                  ? { ...t, result: data.text, is_error: data.is_error, running: false }
                  : t
              )
              msgs[msgs.length - 1] = last
              return msgs
            })
          } else if (data.type === 'delta') {
            setMessages(prev => {
              const msgs = [...prev]
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                text: msgs[msgs.length - 1].text + data.text,
              }
              return msgs
            })
          } else if (data.type === 'done') {
            setMessages(prev => {
              const finalMsgs = prev.map((m, i) =>
                i === prev.length - 1 ? { ...m, streaming: false } : m
              )
              onDone?.(finalMsgs)
              return finalMsgs
            })
          } else if (data.type === 'error') {
            setStatus(`error: ${data.text}`)
          }
        } catch {}
      }
    }
  }, [])

  useEffect(() => {
    if (!convId) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`${API_BASE}/v1/chat/pending/${convId}`, { headers: headers() })
        const d = await r.json()
        if (cancelled) return
        if (!d.msg_id) {
          // No live stream. Clear any stale streaming placeholder (e.g. server
          // restarted mid-turn) so it doesn't spin forever.
          setMessages(prev => {
            if (prev.length && prev[prev.length - 1].streaming) {
              const msgs = [...prev]
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false }
              return msgs
            }
            return prev
          })
          return
        }

        setMessages(prev => {
          if (prev.length > 0 && prev[prev.length - 1].streaming) return prev
          return [...prev, { role: 'assistant', text: '', thinking: '', streaming: true }]
        })
        setLoading(true)
        setStatus('reconnecting to stream...')

        const res = await fetch(`${API_BASE}/v1/chat/resume/${d.msg_id}`, { headers: headers() })
        if (cancelled) return
        setStatus('')
        await processStream(res.body.getReader(), {
          onDone: (finalMsgs) => onSaveConversation(finalMsgs, null, convId),
        })
      } catch {}
      if (!cancelled) { setLoading(false); setStatus('') }
    })()
    return () => { cancelled = true }
  }, [convId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    setIsAtBottom(true)
  }, [])

  const onChatScroll = useCallback((e) => {
    const el = e.currentTarget
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60
    setIsAtBottom(atBottom)
    if (el.scrollTop < 40 && visibleCount < messagesRef.current.length) {
      prevScrollHeightRef.current = el.scrollHeight
      setVisibleCount(c => Math.min(messagesRef.current.length, c + MESSAGES_PAGE_SIZE))
    }
  }, [visibleCount])

  useLayoutEffect(() => {
    if (prevScrollHeightRef.current != null && chatAreaRef.current) {
      const el = chatAreaRef.current
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current
      prevScrollHeightRef.current = null
    }
  }, [visibleCount])

  const visibleMessages = messages.slice(-visibleCount)
  const hasMoreHistory = messages.length > visibleCount

  const send = useCallback(async () => {
    const text = input.trim()
    const hasImages = attachments.length > 0
    if ((!text && !hasImages) || loading) return
    if (attachments.some(a => a.uploading)) {
      setStatus('waiting for upload to finish...')
      return
    }
    if (attachments.some(a => a.error || !a.path)) {
      setStatus('error: some images failed to upload; remove them before sending')
      return
    }

    const imagesPayload = attachments.map(a => ({ path: a.path, mime: a.mime }))
    const imagesForMsg = attachments.map(a => ({
      path: a.path, mime: a.mime, url: a.url,
    }))

    setInput('')
    setAttachments([])
    setLoading(true)
    setStatus('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    const effectiveConvId = convId || crypto.randomUUID()

    const userMsg = { role: 'user', text, ...(imagesForMsg.length ? { images: imagesForMsg } : {}) }
    const assistantMsg = { role: 'assistant', text: '', thinking: '', streaming: true }

    setMessages(prev => [...prev, userMsg, assistantMsg])

    let waitTimer = null
    let waitSeconds = 0
    waitTimer = setInterval(() => {
      waitSeconds++
      setStatus(`waiting for Claude... ${waitSeconds}s`)
    }, 1000)

    try {
      const res = await fetch(`${API_BASE}/v1/chat`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conv_id: effectiveConvId,
          model,
          ...(imagesPayload.length ? { images: imagesPayload } : {}),
        }),
      })

      if (waitTimer) { clearInterval(waitTimer); waitTimer = null }
      setStatus('')
      await processStream(res.body.getReader(), {
        onDone: (finalMsgs) => onSaveConversation(finalMsgs, text, effectiveConvId),
      })
    } catch (e) {
      setStatus(`error: ${e.message}`)
    } finally {
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null }
      setLoading(false)
      setStatus('')
    }
  }, [input, loading, convId, model, onSaveConversation, attachments])

  const [sidCopied, setSidCopied] = useState(false)
  const copySid = useCallback(() => {
    const id = sessionId || convId
    if (!id) return
    try {
      navigator.clipboard?.writeText(id)
      setSidCopied(true)
      setTimeout(() => setSidCopied(false), 1200)
    } catch {}
  }, [sessionId, convId])

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }

  const onInput = (e) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'
  }

  return (
    <div className="chat-panel">
      <div className="chat-topbar">
        <select
          className="model-select"
          value={model || DEFAULT_MODEL}
          onChange={e => onModelChange(e.target.value)}
          disabled={loading}
          title="Claude model"
        >
          {MODELS.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <span
          className={`sid-pill${sidCopied ? ' sid-pill--copied' : ''}`}
          title={sessionId ? `session: ${sessionId}\nconv: ${convId}` : convId ? `conv: ${convId}` : 'new conversation'}
          onClick={copySid}
        >
          {sidCopied ? 'copied!' : `s: ${sessionId ? sessionId.slice(0, 8) : '---'}`}
        </span>
      </div>
      <div className="chat-area-wrap">
        <div className="chat-area" ref={chatAreaRef} onScroll={onChatScroll}>
          {messages.length === 0 && (
            <div className="empty-state">
              <h2>butter notebooks</h2>
              <p>Chat with Claude. Files stay on your Mac mini.</p>
            </div>
          )}
          {hasMoreHistory && (
            <div className="history-more-hint">上滑加载更早的消息 ({messages.length - visibleCount})</div>
          )}
          {visibleMessages.map((msg, i) => (
            <div key={(messages.length - visibleCount) + i} className={`message ${msg.role}`}>
              {msg.role === 'assistant' ? (
                <div className="msg-assistant">
                  {msg.thinking ? <div className="msg-thinking">{msg.thinking}</div> : null}
                  {msg.tools && msg.tools.length > 0 && (
                    <div className="msg-tools">
                      {msg.tools.map((t, ti) => <ToolCard key={t.id || ti} tool={t} />)}
                    </div>
                  )}
                  {msg.text === '' && msg.streaming && !(msg.tools && msg.tools.length)
                    ? <div className="thinking-dots"><span/><span/><span/></div>
                    : msg.text === '' && !msg.streaming && !msg.thinking && !(msg.tools && msg.tools.length)
                      ? <div className="msg-empty">(no reply)</div>
                      : msg.text
                        ? <MdMessage text={msg.text} streaming={msg.streaming} />
                        : null
                  }
                </div>
              ) : (
                <div className="msg-user-wrap">
                  {msg.images && msg.images.length > 0 && (
                    <div className="msg-images">
                      {msg.images.map((im, j) =>
                        im.url ? <AuthImage key={j} url={im.url} className="msg-image" alt="attached" /> : null
                      )}
                    </div>
                  )}
                  {msg.text ? <div className="msg-body">{msg.text}</div> : null}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        {!isAtBottom && (
          <button className="scroll-to-bottom" onClick={scrollToBottom} title="Jump to latest">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="input-area">
        <div className="input-inner">
          {attachments.length > 0 && (
            <div className="attach-strip">
              {attachments.map(a => (
                <div key={a.id} className={`attach-thumb ${a.uploading ? 'uploading' : ''} ${a.error ? 'error' : ''}`}>
                  <img src={a.preview} alt="" />
                  {a.uploading && <div className="attach-spinner" />}
                  {a.error && <div className="attach-err" title={a.error}>!</div>}
                  <button
                    type="button"
                    className="attach-remove"
                    onClick={() => removeAttachment(a.id)}
                    aria-label="Remove"
                  >x</button>
                </div>
              ))}
            </div>
          )}
          <div className="input-row">
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              title="Attach image"
              aria-label="Attach image"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={onPickFiles}
            />
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Message..."
              value={input}
              onChange={onInput}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <button
              className="send-btn"
              onClick={send}
              disabled={(!input.trim() && attachments.length === 0) || loading || attachments.some(a => a.uploading || a.error)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="status-bar">{status}</div>
    </div>
  )
}
