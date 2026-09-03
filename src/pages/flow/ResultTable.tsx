import { useMemo } from 'react'
import { ListMinus, Search, X } from 'lucide-react'
import {
  BulkBar,
  SelectAllCell,
  SelectCell,
  SelectColumns,
} from '../../components/BulkSelection'
import { formatBytes, isOutsideProfile } from '../../domain/media'
import { isOnDestination } from '../../domain/plan'
import type { MediaItem, Profile, ResultStatus, TransferResultEntry } from '../../domain/types'
import { useRowSelection } from '../../hooks/useRowSelection'

export type ResultView = 'current' | 'changes' | 'result'

const STATUS_LABELS: Record<ResultStatus, string> = {
  add: 'Added',
  move: 'Moved',
  remove: 'Removed',
  conflict: 'Conflict',
  unchanged: 'On target',
}

/**
 * Filters the merged inventory for one view.
 *
 * `current` is what the destination holds today, `changes` is what this plan
 * alters, and `result` is what will be there afterwards. All three come from
 * the same native array, so they can never disagree.
 */
export function filterResult(
  entries: TransferResultEntry[],
  view: ResultView,
  query: string,
): TransferResultEntry[] {
  const needle = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (view === 'current' && !isOnDestination(entry)) return false
    if (view === 'changes' && entry.status === 'unchanged') return false
    if (view === 'result' && entry.status === 'remove') return false
    return entry.path.toLowerCase().includes(needle)
  })
}

export function ResultTable({
  entries,
  profile,
  view,
  setView,
  query,
  setQuery,
  itemsByPath,
  removeFromCollection,
  emptyMessage,
}: {
  entries: TransferResultEntry[]
  profile: Profile
  view: ResultView
  setView: (view: ResultView) => void
  query: string
  setQuery: (query: string) => void
  /** Lets a staged addition be taken back out from the review table. */
  itemsByPath: Map<string, MediaItem>
  removeFromCollection: (itemIds: string[]) => void
  emptyMessage: string
}) {
  const visible = useMemo(
    () => filterResult(entries, view, query),
    [entries, view, query],
  )

  // Only staged additions can be taken back from here: a file that is already
  // on the destination is the removal policy's business, not the collection's.
  const stagedIds = useMemo(
    () =>
      visible
        .map((entry) => itemsByPath.get(entry.path.toLowerCase())?.id)
        .filter((id): id is string => Boolean(id)),
    [visible, itemsByPath],
  )
  const selection = useRowSelection(stagedIds)

  return (
    <div className="flow-stage-body">
      <div className="result-view-bar">
        <div className="result-view-tabs" role="tablist" aria-label="Destination contents view">
          {(['current', 'changes', 'result'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={view === value}
              className={view === value ? 'active' : ''}
              onClick={() => setView(value)}
            >
              {value === 'current' ? 'Current load' : value === 'changes' ? 'Changes' : 'Result'}
            </button>
          ))}
        </div>
        <label className="result-search">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${view}`}
          />
        </label>
      </div>
      <BulkBar selection={selection} noun="staged titles">
        <button
          className="button secondary compact"
          onClick={() => {
            removeFromCollection([...selection.selected])
            selection.clear()
          }}
        >
          <ListMinus />
          Remove {selection.count} from {profile.name}
        </button>
      </BulkBar>
      <div className="table-wrap build-result-table-wrap">
        <table className="build-result-table">
          <SelectColumns />
          <thead>
            <tr>
              <SelectAllCell
                selection={selection}
                label={`Select all ${stagedIds.length} staged titles shown`}
              />
              <th>State</th>
              <th>Destination path</th>
              <th>Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => {
              const item = itemsByPath.get(entry.path.toLowerCase())
              // Files already on the destination that this profile's platform
              // does not manage are flagged, never silently hidden or removed.
              const outside = isOnDestination(entry) && isOutsideProfile(profile, entry.path)
              return (
                <tr
                  key={`${entry.status}:${entry.path}`}
                  className={outside ? 'result-mismatch' : `result-${entry.status}`}
                >
                  <SelectCell
                    selection={selection}
                    id={item?.id || entry.path}
                    label={`Select ${item?.canonicalTitle || entry.path}`}
                    disabled={!item}
                    reason="Already on the destination; nothing to take back out"
                  />
                  <td>
                    <span className="change-label">
                      {outside ? 'Profile mismatch' : STATUS_LABELS[entry.status]}
                    </span>
                  </td>
                  <td title={entry.path}>
                    {entry.previousPath ? `${entry.previousPath} → ${entry.path}` : entry.path}
                  </td>
                  <td>{formatBytes(entry.resultSize ?? entry.currentSize ?? 0)}</td>
                  <td>
                    {item && (
                      <button
                        className="row-action"
                        title={`Remove ${item.canonicalTitle} from this profile`}
                        onClick={() => removeFromCollection([item.id])}
                      >
                        <X />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!visible.length && <p className="result-empty">{emptyMessage}</p>}
      </div>
    </div>
  )
}
