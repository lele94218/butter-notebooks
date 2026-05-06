import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'

export default function CodeBlock({ lang, codeStyle, children }) {
  const [copied, setCopied] = useState(false)
  const text = String(children).replace(/^[^\S\n]*\n/, '').replace(/\n$/, '')
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <div className="code-block-wrap">
      <SyntaxHighlighter
        style={codeStyle}
        language={lang || 'text'}
        PreTag="div"
        customStyle={{ margin: 0, overflowX: 'auto' }}
      >
        {text}
      </SyntaxHighlighter>
      <button className={`code-copy-btn${copied ? ' copied' : ''}`} onClick={copy}>
        {copied ? '✓ copied' : 'copy'}
      </button>
    </div>
  )
}
