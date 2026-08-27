import { ChevronLeft, ChevronRight, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Check } from 'lucide-react'
import { FileBrowserTable } from '../../components/FileBrowserTable'
import { Modal } from '../../components/Modal'
import { relativeTo, toPosix } from '../../domain/paths'
import type { DestinationEdit, FileEntry, Profile } from '../../domain/types'
import type { DirectoryBrowser } from '../../hooks/useDirectoryBrowser'
import { isWritable } from '../../state/workspace'

/**
 * Step 2: what is on the destination now, and what the user wants to move or
 * delete before anything is added.
 *
 * Edits are only staged here. Nothing is applied until the confirmation step,
 * and the planner validates every one of them again at that point.
 */
export function ContentsStep({
  profile,
  browser,
  edits,
  setEdits,
  back,
  next,
}: {
  profile: Profile
  browser: DirectoryBrowser
  edits: DestinationEdit[]
  setEdits: React.Dispatch<React.SetStateAction<DestinationEdit[]>>
  back: () => void
  next: () => void
}) {
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [moveTo, setMoveTo] = useState<string | null>(null)
  const editable = isWritable(profile)

  const relativePath = (entry: FileEntry) =>
    browser.isImage ? toPosix(entry.path) : relativeTo(profile.destination.path, entry.path)

  const stage = (edit: DestinationEdit) => {
    setEdits((current) => [
      ...current.filter((existing) => existing.path.toLowerCase() !== edit.path.toLowerCase()),
      edit,
    ])
    setSelected(null)
  }

  return (
    <div className="flow-stage-body">
      <div className="destination-browser-bar">
        <div>
          <b>Destination contents</b>
          <span title={browser.path}>
            {browser.isImage
              ? `${profile.destination.path} :: /${browser.path}`
              : browser.path}
          </span>
        </div>
        <div className="inline-actions">
          {browser.canGoUp && (
            <button
              className="icon-button"
              title="Parent folder"
              onClick={() => void browser.goUp()}
            >
              <ChevronLeft />
            </button>
          )}
          <button
            className="icon-button"
            title="Refresh contents"
            onClick={() => void browser.refresh()}
          >
            <RefreshCw className={browser.busy ? 'spinning' : ''} />
          </button>
        </div>
      </div>

      {!editable && (
        <div className="source-status info">
          FAT image contents are read-only. Move and delete are available for folder
          and mounted volume profiles.
        </div>
      )}

      {editable && selected && (
        <div className="destination-edit-bar">
          <span>Selected: {selected.name}</span>
          <button
            className="button secondary"
            onClick={() => setMoveTo(relativePath(selected))}
          >
            <Pencil />
            Move / rename
          </button>
          <button
            className="button secondary danger"
            onClick={() => stage({ kind: 'delete', path: relativePath(selected) })}
          >
            <Trash2 />
            Delete
          </button>
        </div>
      )}

      {edits.length > 0 && (
        <div className="staged-edits">
          <b>Staged destination edits</b>
          {edits.map((edit) => (
            <span key={`${edit.kind}:${edit.path}`}>
              <span>
                {edit.kind === 'move'
                  ? `${edit.path} → ${edit.destination}`
                  : `Delete ${edit.path}`}
              </span>
              <button
                className="row-action"
                title="Undo this staged edit"
                onClick={() =>
                  setEdits((current) => current.filter((entry) => entry !== edit))
                }
              >
                <X />
              </button>
            </span>
          ))}
        </div>
      )}

      {browser.error && <p className="inline-error">{browser.error}</p>}

      <div className="table-wrap build-result-table-wrap destination-browser">
        <FileBrowserTable
          entries={browser.entries}
          isImage={browser.isImage}
          selectedPath={selected?.path}
          onSelect={(entry) => editable && setSelected(entry)}
          onOpen={(entry) => void browser.open(entry.path)}
        />
      </div>

      <div className="flow-actions">
        <button className="button secondary" onClick={back}>
          <ChevronLeft />
          Back
        </button>
        <button className="button" onClick={next}>
          Choose sources
          <ChevronRight />
        </button>
      </div>

      {moveTo !== null && selected && (
        <MoveDialog
          from={relativePath(selected)}
          value={moveTo}
          setValue={setMoveTo}
          close={() => setMoveTo(null)}
          confirm={(destination) => {
            stage({ kind: 'move', path: relativePath(selected), destination })
            setMoveTo(null)
          }}
        />
      )}
    </div>
  )
}

function MoveDialog({
  from,
  value,
  setValue,
  close,
  confirm,
}: {
  from: string
  value: string
  setValue: (value: string) => void
  close: () => void
  confirm: (destination: string) => void
}) {
  // The planner requires `/` separators and rejects anything that would leave
  // the destination, so the input is normalised before it is staged.
  const normalised = toPosix(value).replace(/^\/+/, '').trim()
  const invalid = !normalised || normalised === from || normalised.includes('..')

  return (
    <Modal title="Move or rename" onClose={close}>
      <p>Enter the new path relative to the destination root.</p>
      <label>
        Destination path
        <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      {normalised.includes('..') && (
        <p className="inline-error">A destination path cannot leave the profile's folder.</p>
      )}
      <button className="button" disabled={invalid} onClick={() => confirm(normalised)}>
        <Check />
        Stage move
      </button>
    </Modal>
  )
}
