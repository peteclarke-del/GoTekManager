import { formatBytes } from '../domain/media'
import type { FileEntry } from '../domain/types'

/**
 * The destination listing, shared by the guided flow and the profiles screen.
 *
 * Folders open on double-click and on Enter or Space when focused, so the table
 * is usable without a mouse.
 */
export function FileBrowserTable({
  entries,
  emptyMessage = 'This folder is empty.',
  selectedPath,
  onSelect,
  onOpen,
  isImage = false,
}: {
  entries: FileEntry[]
  emptyMessage?: string
  selectedPath?: string
  onSelect?: (entry: FileEntry) => void
  onOpen?: (entry: FileEntry) => void
  isImage?: boolean
}) {
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Size</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.path}
              className={[
                entry.directory ? 'clickable' : '',
                selectedPath === entry.path ? 'selected-row' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              tabIndex={entry.directory ? 0 : undefined}
              onClick={() => onSelect?.(entry)}
              onDoubleClick={() => entry.directory && onOpen?.(entry)}
              onKeyDown={(event) => {
                if (!entry.directory) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen?.(entry)
                }
              }}
            >
              <td>
                <b>{entry.name}</b>
              </td>
              <td>{entry.directory ? 'Folder' : `.${entry.extension}`}</td>
              <td>{entry.directory ? '' : formatBytes(entry.size)}</td>
              <td>
                {entry.modified
                  ? new Date(entry.modified * 1000).toLocaleString()
                  : isImage
                    ? 'Image entry'
                    : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!entries.length && <p className="result-empty">{emptyMessage}</p>}
    </>
  )
}
