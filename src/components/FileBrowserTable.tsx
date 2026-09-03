import { FolderOpen } from 'lucide-react'
import { formatBytes } from '../domain/media'
import type { FileEntry } from '../domain/types'
import type { RowSelection } from '../hooks/useRowSelection'
import { SelectAllCell, SelectCell, SelectColumns } from './BulkSelection'

/**
 * The destination listing, shared by the guided flow and the profiles screen.
 *
 * A folder opens on a single click of its name, on double-clicking its row, and
 * on Enter or Space when the row is focused, so browsing works by mouse or by
 * keyboard and does not depend on a gesture nobody has been told about. Given a
 * `selection`, each row also carries a tick box so several files can be acted on
 * at once; without one the table is the plain listing the profiles screen
 * browses with.
 */
export function FileBrowserTable({
  entries,
  emptyMessage = 'This folder is empty.',
  selectedPath,
  selection,
  onSelect,
  onOpen,
  isImage = false,
}: {
  entries: FileEntry[]
  emptyMessage?: string
  selectedPath?: string
  selection?: RowSelection
  onSelect?: (entry: FileEntry) => void
  onOpen?: (entry: FileEntry) => void
  isImage?: boolean
}) {
  return (
    <>
      <table>
        {selection && <SelectColumns />}
        <thead>
          <tr>
            {selection && (
              <SelectAllCell
                selection={selection}
                label={`Select all ${entries.length} entries in this folder`}
              />
            )}
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
                selectedPath === entry.path || selection?.isSelected(entry.path)
                  ? 'selected-row'
                  : '',
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
              {selection && (
                <SelectCell
                  selection={selection}
                  id={entry.path}
                  label={`Select ${entry.name}`}
                />
              )}
              <td>
                {entry.directory && onOpen ? (
                  <button
                    className="browse-into"
                    title={`Open ${entry.name}`}
                    onClick={(event) => {
                      // The row's own click ticks the box; opening is its own act.
                      event.stopPropagation()
                      onOpen(entry)
                    }}
                  >
                    <FolderOpen />
                    {entry.name}
                  </button>
                ) : (
                  <b>{entry.name}</b>
                )}
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
