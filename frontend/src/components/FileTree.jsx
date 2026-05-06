const IconFolderOpen = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0}}>
    <path d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6l1.5 1.5H13.5A1 1 0 0 1 14.5 5V12.5A1 1 0 0 1 13.5 13.5H2.5A1 1 0 0 1 1.5 12.5V3.5Z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
    <path d="M1.5 6.5H14.5L13 12.5H3L1.5 6.5Z" fill="currentColor" fillOpacity="0.35" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round"/>
  </svg>
)

const IconFolderClosed = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0}}>
    <path d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6l1.5 1.5H13.5A1 1 0 0 1 14.5 5V12.5A1 1 0 0 1 13.5 13.5H2.5A1 1 0 0 1 1.5 12.5V3.5Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
  </svg>
)

const IconFile = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0}}>
    <path d="M3.5 1.5H9.5L12.5 4.5V14.5A0.5 0.5 0 0 1 12 15H4A0.5 0.5 0 0 1 3.5 14.5V1.5Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
    <path d="M9.5 1.5V4.5H12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M5.5 7.5H10.5M5.5 9.5H10.5M5.5 11.5H8.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round"/>
  </svg>
)

export function buildTree(paths) {
  const root = {}
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || { __dir: true, __children: {} }
      node = node[parts[i]].__children
    }
    node[parts[parts.length - 1]] = { __dir: false, __path: p }
  }
  return root
}

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
            const key = name + depth
            const open = openDirs[key] !== false
            return (
              <div key={key}>
                <div
                  className="tree-dir"
                  style={{ paddingLeft: 8 + depth * 14 + 'px' }}
                  onClick={() => toggleDir(key)}
                >
                  <span className="tree-arrow">{open ? '▾' : '▸'}</span>
                  {open ? <IconFolderOpen /> : <IconFolderClosed />}
                  <span className="tree-dir-name">{name}</span>
                </div>
                {open && (
                  <FileTree
                    tree={node.__children}
                    depth={depth + 1}
                    selectedNote={selectedNote}
                    onSelect={onSelect}
                    openDirs={openDirs}
                    toggleDir={toggleDir}
                  />
                )}
              </div>
            )
          }
          return (
            <div
              key={node.__path}
              className={`note-item tree-file ${selectedNote === node.__path ? 'active' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 + 'px' }}
              title={node.__path}
              onClick={() => onSelect(node.__path)}
            >
              <IconFile />
              <span>{name.replace(/\.md$/, '')}</span>
            </div>
          )
        })}
    </>
  )
}
