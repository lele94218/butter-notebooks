// Chevron used as the expand/collapse affordance (VSCode-style: it rotates).
const IconChevron = () => (
  <svg className="tree-chevron-svg" width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const IconFolder = ({ open }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    {open ? (
      <path d="M1.8 12.8V4.2a.9.9 0 0 1 .9-.9h3.1l1.3 1.5h5.4a.9.9 0 0 1 .9.9v.9H4.6a.9.9 0 0 0-.86.65L1.8 12.8Z"
        fill="currentColor" fillOpacity="0.9"/>
    ) : (
      <path d="M1.8 4.2a.9.9 0 0 1 .9-.9h3.1l1.3 1.5h6.1a.9.9 0 0 1 .9.9v6.1a.9.9 0 0 1-.9.9H2.7a.9.9 0 0 1-.9-.9V4.2Z"
        fill="currentColor" fillOpacity="0.75"/>
    )}
    {open && (
      <path d="M3.74 6.75A.9.9 0 0 1 4.6 6.1h9.3a.6.6 0 0 1 .57.79l-1.6 5a.9.9 0 0 1-.86.62H2.5l1.24-5.76Z"
        fill="currentColor" fillOpacity="0.45"/>
    )}
  </svg>
)

// Markdown file icon — page outline with a small "M↓" so notes read as notes.
const IconMarkdown = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path d="M3.8 1.8h5l3.4 3.4v9a.6.6 0 0 1-.6.6H3.8a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6Z"
      stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill="currentColor" fillOpacity="0.08"/>
    <path d="M8.8 1.9v3.4h3.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M5.1 12.2V8.6l1.6 1.9 1.6-1.9v3.6" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M10.4 8.9v3.2m0 0 1-1m-1 1-1-1" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const IconFile = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path d="M3.8 1.8h5l3.4 3.4v9a.6.6 0 0 1-.6.6H3.8a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6Z"
      stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill="currentColor" fillOpacity="0.08"/>
    <path d="M8.8 1.9v3.4h3.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

export function buildTree(paths) {
  const root = {}
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      // Directories carry their full path too. Keying open/closed state on
      // name+depth meant two folders of the same name at the same level shared
      // one state — and one React key.
      const dirPath = parts.slice(0, i + 1).join('/')
      node[parts[i]] = node[parts[i]] || { __dir: true, __path: dirPath, __children: {} }
      node = node[parts[i]].__children
    }
    node[parts[parts.length - 1]] = { __dir: false, __path: p }
  }
  return root
}

// Every directory on the way down to a file, so the tree can reveal a selection.
export function ancestorsOf(filePath) {
  const parts = (filePath || '').split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

// Indent per level. The guide line for a level sits at the parent's icon column.
const INDENT = 13
const PAD_LEFT = 6

export default function FileTree({ tree, depth = 0, selectedNote, onSelect, openDirs, toggleDir }) {
  return (
    <>
      {Object.entries(tree)
        .sort(([a, av], [b, bv]) => {
          if (av.__dir !== bv.__dir) return av.__dir ? -1 : 1
          return a.localeCompare(b)
        })
        .map(([name, node]) => {
          if (node.__dir) {
            const key = node.__path
            // Closed unless explicitly opened: expanding everything turned a
            // 19-directory vault into a very long scroll.
            const open = openDirs[key] === true
            return (
              <div key={key} className="tree-branch">
                <div
                  className={`tree-row tree-dir ${open ? 'is-open' : ''}`}
                  style={{ paddingLeft: PAD_LEFT + depth * INDENT + 'px' }}
                  onClick={() => toggleDir(key)}
                  title={name}
                >
                  <span className="tree-chevron"><IconChevron /></span>
                  <span className="tree-icon tree-icon--dir"><IconFolder open={open} /></span>
                  <span className="tree-label">{name}</span>
                </div>
                {open && (
                  <div className="tree-children" style={{ '--guide-left': PAD_LEFT + depth * INDENT + 12 + 'px' }}>
                    <FileTree
                      tree={node.__children}
                      depth={depth + 1}
                      selectedNote={selectedNote}
                      onSelect={onSelect}
                      openDirs={openDirs}
                      toggleDir={toggleDir}
                    />
                  </div>
                )}
              </div>
            )
          }
          const isMd = /\.md$/i.test(name)
          return (
            <div
              key={node.__path}
              className={`tree-row tree-file ${selectedNote === node.__path ? 'active' : ''}`}
              style={{ paddingLeft: PAD_LEFT + depth * INDENT + 'px' }}
              title={node.__path}
              onClick={() => onSelect(node.__path)}
            >
              <span className="tree-chevron" />
              <span className="tree-icon">{isMd ? <IconMarkdown /> : <IconFile />}</span>
              <span className="tree-label">{name.replace(/\.md$/i, '')}</span>
            </div>
          )
        })}
    </>
  )
}
