import { memo, useMemo, useContext } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ThemeContext } from '../lib/theme'
import CodeBlock from './CodeBlock'
import ZoomableImg from './ImageViewer'
import AuthImage from './AuthImage'

// Rewrite markdown refs to a local image file → the served /v1/img URL so the
// image renders (mirrors the backend shim). Handles `![alt](path)` and upgrades
// `[alt](path)` links; supports file:// and <angle-bracketed paths with spaces>.
// The backend /v1/img endpoint enforces existence + allowed-root; here we only
// rewrite the URL. No token in the URL — nginx logs query strings in full, so
// embedding it published the credential on every image request. These are
// fetched as blobs with an Authorization header instead (see AuthImage).
const LOCAL_IMG_RE = /!?(\[[^\]]*\]\(\s*)(?:<(?:file:\/\/)?(\/[^>]+?\.(?:png|jpe?g|gif|webp|bmp))\s*>|(?:file:\/\/)?(\/(?:[^)\s<>]|%20)+\.(?:png|jpe?g|gif|webp|bmp)))(\s*\))/gi

function rewriteLocalImages(text) {
  if (!text || text.indexOf('](') === -1) return text
  return text.replace(LOCAL_IMG_RE, (full, open, anglePath, barePath, close) => {
    const path = (anglePath || barePath || '').trim()
    const enc = encodeURIComponent(path).replace(/%2F/g, '/')
    return '!' + open + `/v1/img?p=${enc}` + close
  })
}

// Shared so the Notes tab can highlight a whole source file with the same
// colours the chat uses for a fenced block.
function makeCodeStyle(theme) {
  const base = theme === 'dark' ? oneDark : oneLight
  return {
    ...base,
    'pre[class*="language-"]': {
      ...base['pre[class*="language-"]'],
      background: theme === 'dark' ? 'hsl(60 2.6% 7.6%)' : 'hsl(220 14% 96%)',
      borderRadius: '10px',
      border: theme === 'dark'
        ? '0.5px solid hsl(51 16.5% 84.5% / 12%)'
        : '0.5px solid hsl(220 14% 88%)',
      padding: '14px 16px',
      margin: 0,
      fontSize: '12.5px',
    },
    'code[class*="language-"]': {
      ...base['code[class*="language-"]'],
      fontSize: '12.5px',
      fontFamily: '"Anthropic Mono", ui-monospace, Consolas, monospace',
      background: 'none',
    },
  }
}

function makeMdComponents(theme) {
  const codeStyle = makeCodeStyle(theme)
  return {
    pre({ children }) {
      return <>{children}</>
    },
    code({ className, children }) {
      const match = /language-(\w+)/.exec(className || '')
      const isBlock = !!match || String(children).includes('\n')
      if (!isBlock) return <code>{children}</code>
      const lang = match ? match[1] : ''
      return <CodeBlock lang={lang} codeStyle={codeStyle}>{children}</CodeBlock>
    },
    a({ href, children }) {
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    },
    img({ src, alt }) {
      const style = { maxWidth: '100%', height: 'auto', borderRadius: 8, display: 'block' }
      // Our own image route needs the auth header, so it goes through AuthImage
      // (which fetches a blob and renders it zoomable). Anything else is a
      // plain remote URL.
      if (typeof src === 'string' && src.startsWith('/v1/img')) {
        return <AuthImage url={src} alt={alt || ''} style={style} />
      }
      return <ZoomableImg src={src} alt={alt || ''} style={style} />
    },
    table({ children }) {
      return <div className="table-scroll"><table>{children}</table></div>
    },
  }
}

const katexOptions = { throwOnError: false, strict: false }

const MdMessage = memo(function MdMessage({ text, streaming }) {
  const theme = useContext(ThemeContext)
  const mdComponents = useMemo(() => makeMdComponents(theme), [theme])
  const rendered = useMemo(() => rewriteLocalImages(text), [text])
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, katexOptions]]}
        components={mdComponents}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  )
})

export default MdMessage
export { makeMdComponents, makeCodeStyle, katexOptions }
