import { ChevronLeft, ChevronRight, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { BulkBar } from '../../components/BulkSelection'
import { FileBrowserTable } from '../../components/FileBrowserTable'
import { Modal } from '../../components/Modal'
import { joinRelative, relativeTo, toPosix } from '../../domain/paths'
import type { DestinationEdit, FileEntry, Profile } from '../../domain/types'
import type { DirectoryBrowser } from '../../hooks/useDirectoryBrowser'
import { useRowSelection } from '../../hooks/useRowSelection'
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
  const [moving, setMoving] = useState<FileEntry[] | null>(null)
  const editable = isWritable(profile)

  const paths = useMemo(() => browser.entries.map((entry) => entry.path), [browser.entries])
  const selection = useRowSelection(paths)
  const chosen = selection.chosen(browser.entries, (entry) => entry.path)

  const relativePath = (entry: FileEntry) =>
    browser.isImage ? toPosix(entry.path) : relativeTo(profile.destination.path, entry.path)

  /** Replaces any edit already staged for the same file, then clears the ticks. */
  const stage = (staged: DestinationEdit[]) => {
    const replaced = new Set(staged.map((edit) => edit.path.toLowerCase()))
    setEdits((current) => [
      ...current.filter((existing) => !replaced.has(existing.path.toLowerCase())),
      ...staged,
    ])
    selection.clear()
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

      {editable && (
        <BulkBar selection={selection} noun="entries">
          <button
            className="button secondary compact"
            title={
              chosen.length === 1
                ? 'Move or rename this entry'
                : `Move all ${chosen.length} into one folder`
            }
            onClick={() => setMoving(chosen)}
          >
            <Pencil />
            {chosen.length === 1 ? 'Move / rename' : `Move ${chosen.length} into a folder`}
          </button>
          <button
            className="button secondary compact danger"
            onClick={() =>
              stage(
                chosen.map((entry) => ({ kind: 'delete', path: relativePath(entry) })),
              )
            }
          >
            <Trash2 />
            Delete {chosen.length}
          </button>
        </BulkBar>
      )}

      {edits.length > 0 && (
        <div className="staged-edits">
          <div className="staged-edits-head">
            <b>Staged destination edits</b>
            {edits.length > 1 && (
              <button className="button secondary compact" onClick={() => setEdits([])}>
                <X />
                Undo all {edits.length}
              </button>
            )}
          </div>
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
          selection={editable ? selection : undefined}
          onSelect={(entry) => editable && selection.toggle(entry.path)}
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

      {moving?.length ? (
        <MoveDialog
          entries={moving}
          pathOf={relativePath}
          close={() => setMoving(null)}
          confirm={(staged) => {
            stage(staged)
            setMoving(null)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Where the selected entries should end up.
 *
 * One entry is moved to a path of its own, which is also how it is renamed.
 * Several keep their names and are moved into a folder together, because
 * renaming a dozen files to one name is never what was meant.
 */
function MoveDialog({
  entries,
  pathOf,
  close,
  confirm,
}: {
  entries: FileEntry[]
  pathOf: (entry: FileEntry) => string
  close: () => void
  confirm: (edits: DestinationEdit[]) => void
}) {
  const single = entries.length === 1 ? entries[0] : undefined
  const [value, setValue] = useState(single ? pathOf(single) : '')

  // The planner requires `/` separators and rejects anything that would leave
  // the destination, so the input is normalised before it is staged.
  const normalised = toPosix(value).replace(/^\/+/, '').trim()
  const escapes = normalised.includes('..')
  const staged = single
    ? [{ kind: 'move' as const, path: pathOf(single), destination: normalised }]
    : entries.map((entry) => ({
        kind: 'move' as const,
        path: pathOf(entry),
        destination: joinRelative(normalised, entry.name),
      }))
  // Moving something to where it already is is not a move, so it is refused
  // here rather than staged and then rejected by the planner.
  const unchanged = staged.every((edit) => edit.destination === edit.path)
  const invalid = escapes || unchanged || (single ? !normalised : false)

  return (
    <Modal
      title={single ? 'Move or rename' : `Move ${entries.length} entries`}
      onClose={close}
    >
      <p>
        {single
          ? 'Enter the new path relative to the destination root.'
          : 'Enter the folder, relative to the destination root, to move them into. Each keeps its own name.'}
      </p>
      <label>
        {single ? 'Destination path' : 'Destination folder'}
        <input
          autoFocus
          value={value}
          placeholder={single ? undefined : 'BBC/Games'}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {escapes && (
        <p className="inline-error">A destination path cannot leave the profile's folder.</p>
      )}
      {!single && (
        <p className="feed-format">
          First of {entries.length}: <code>{staged[0].destination}</code>
        </p>
      )}
      <button className="button" disabled={invalid} onClick={() => confirm(staged)}>
        <Check />
        {single ? 'Stage move' : `Stage ${entries.length} moves`}
      </button>
    </Modal>
  )
}
