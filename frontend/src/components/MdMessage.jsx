import { memo, useMemo, useContext } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ThemeContext } from '../lib/theme'
import CodeBlock from './CodeBlock'

function makeMdComponents(theme) {
  const base = theme === 'dark' ? oneDark : oneLight
  const codeStyle = {
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
    table({ children }) {
      return <div className="table-scroll"><table>{children}</table></div>
    },
  }
}

const katexOptions = { throwOnError: false, strict: false }

const MdMessage = memo(function MdMessage({ text, streaming }) {
  const theme = useContext(ThemeContext)
  const mdComponents = useMemo(() => makeMdComponents(theme), [theme])
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, katexOptions]]}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

export default MdMessage
export { makeMdComponents, katexOptions }
