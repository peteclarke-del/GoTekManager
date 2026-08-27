import { useEffect, useMemo, useState } from 'react'
import { Check, FolderOpen, ListPlus, Pencil, RefreshCw, Search, Tag, Trash2 } from 'lucide-react'
import { Empty, InlineStatus } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { acceptedFormats, platforms, requireFirmware, type Platform } from '../../domain/catalog'
import {
  belongsToPlatform,
  forProfile,
  formatBytes,
  isFirmwareCompatible,
  outputFileName,
  outputFolder,
  transferOperations,
} from '../../domain/media'
import { relativeTo } from '../../domain/paths'
import type {
  FileStatus,
  MediaItem,
  Profile,
  SourceLocation,
  TargetFileStatus,
} from '../../domain/types'
import { compareTargetFiles } from '../../native/commands'
import { useFingerprintProgress } from '../../hooks/useFingerprintProgress'
import type { TablePreferences } from '../../state/useWorkspace'

/** Which titles to show, by whether the destination already holds them. */
type PresenceFilter = 'all' | 'missing' | 'present'

const PRESENCE_FILTERS: Array<[PresenceFilter, string]> = [
  ['all', 'All'],
  ['missing', 'Not on target'],
  ['present', 'On target'],
]

/**
 * Present means the destination holds these contents somewhere, whether or not
 * it is where this profile would write them. Unavailable counts as missing:
 * whatever is wrong with it, it is not on the media.
 */
function isOnTarget(presence: Presence): boolean {
  return presence === 'Identical' || presence === 'Elsewhere'
}

/** How a library title compares with what is already on the destination. */
type Presence = 'Checking' | 'New' | 'Identical' | 'Different' | 'Elsewhere' | 'Unavailable'

const PRESENCE_BY_STATUS: Record<FileStatus, Presence> = {
  new: 'New',
  identical: 'Identical',
  different: 'Different',
  elsewhere: 'Elsewhere',
  unavailable: 'Unavailable',
}

/** Sort order for the target column: the most actionable state first. */
const PRESENCE_ORDER: Presence[] = [
  'New',
  'Different',
  'Elsewhere',
  'Identical',
  'Unavailable',
  'Checking',
]

const COLUMN_LABELS: Record<string, string> = {
  presence: 'Target',
  title: 'Title',
  platform: 'Platform',
  format: 'Format',
  size: 'Size',
  location: 'Source',
  action: '',
}

type Row = {
  item: MediaItem
  staged: boolean
  presence: Presence
  /** Where the title actually sits, when it is filed somewhere unexpected. */
  foundAt?: string
  location: string
}

export function LocalLibrary({
  profile,
  platform,
  items,
  sources,
  collection,
  addLocation,
  refreshLocation,
  renameLocation,
  removeLocation,
  assignPlatform,
  setDisplayTitle,
  addToCollection,
  preferences,
  setPreferences,
  status,
  busySourceId,
}: {
  profile: Profile
  platform: Platform
  items: MediaItem[]
  sources: SourceLocation[]
  collection: MediaItem[]
  addLocation: () => void
  refreshLocation: (source: SourceLocation) => void
  renameLocation: (source: SourceLocation) => void
  removeLocation: (source: SourceLocation) => void
  assignPlatform: (itemId: string, platformId: string) => void
  setDisplayTitle: (itemId: string, displayTitle: string) => void
  addToCollection: (item: MediaItem) => void
  preferences: TablePreferences
  setPreferences: React.Dispatch<React.SetStateAction<TablePreferences>>
  status: { kind: 'success' | 'error' | 'info'; text: string } | null
  busySourceId: string
}) {
  const [query, setQuery] = useState('')
  /** Source paths to narrow the table to. Empty means every source. */
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [presenceFilter, setPresenceFilter] = useState<PresenceFilter>('all')
  const [editing, setEditing] = useState<SourceLocation | null>(null)
  const [renaming, setRenaming] = useState<MediaItem | null>(null)
  const [statuses, setStatuses] = useState<Record<string, TargetFileStatus>>({})
  const [checking, setChecking] = useState(false)
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null)
  const fingerprinting = useFingerprintProgress()

  const accepted = useMemo(
    () => acceptedFormats(platform.id, profile.firmwareId),
    [platform.id, profile.firmwareId],
  )
  // Formats the machine uses that this firmware cannot read from the stick.
  const convertible = platform.formats.filter((format) => !accepted.includes(format))

  const matching = useMemo(
    () =>
      items.filter(
        (item) =>
          belongsToPlatform(item, platform.id) &&
          item.name.toLowerCase().includes(query.trim().toLowerCase()) &&
          (!selectedSources.length || selectedSources.includes(item.source)),
      ),
    [items, platform.id, query, selectedSources],
  )

  /** How many titles each source contributes for this platform. */
  const countBySource = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      if (!belongsToPlatform(item, platform.id)) continue
      counts.set(item.source, (counts.get(item.source) || 0) + 1)
    }
    return counts
  }, [items, platform.id])

  // Comparing every title with the destination is exact but not free, so it
  // runs once per profile and library change rather than on every keystroke.
  const comparable = useMemo(
    () =>
      items
        .filter((item) => belongsToPlatform(item, platform.id))
        // Compare against the path the title would actually be written to,
        // which for an unassigned title means this profile's platform folder.
        .map((item) => forProfile(item, platform.id)),
    [items, platform.id],
  )
  useEffect(() => {
    let active = true
    if (!comparable.length) {
      setStatuses({})
      return
    }
    setChecking(true)
    compareTargetFiles(
      profile.destination.path,
      transferOperations(comparable, profile),
    )
      .then((results) => {
        if (!active) return
        setStatuses(Object.fromEntries(results.map((entry) => [entry.source, entry])))
      })
      .catch(() => active && setStatuses({}))
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [
    comparable,
    profile.destination.path,
    profile.firmwareId,
    profile.organise,
    profile.folderLayout,
    profile.naming,
  ])

  const staged = useMemo(() => new Set(collection.map((item) => item.id)), [collection])
  const sourceName = (item: MediaItem) => {
    const source = sources.find((entry) => entry.path === item.source)
    const nickname = source?.name || 'Source'
    return `${nickname}:/${relativeTo(item.source, item.path) || item.name}`
  }

  const rows = useMemo<Row[]>(() => {
    const { key, direction } = preferences.sort
    const value = (row: Row): string | number => {
      switch (key) {
        case 'presence':
          return PRESENCE_ORDER.indexOf(row.presence)
        case 'title':
          return row.item.canonicalTitle.toLowerCase()
        case 'platform':
          return row.item.assignedPlatformId || ''
        case 'format':
          return row.item.extension
        case 'size':
          return row.item.size
        default:
          return row.location.toLowerCase()
      }
    }
    return matching
      .map<Row>((item) => ({
        item,
        staged: staged.has(item.id),
        presence: checking
          ? 'Checking'
          : PRESENCE_BY_STATUS[statuses[item.path]?.status] || 'Checking',
        foundAt: statuses[item.path]?.foundAt,
        location: sourceName(item),
      }))
      // While the contents are still being read nothing is known yet, so the
      // filter is held back rather than emptying the table as it works.
      .filter((row) =>
        presenceFilter === 'all' || checking
          ? true
          : (presenceFilter === 'present') === isOnTarget(row.presence),
      )
      .sort((left, right) => {
        const a = value(left)
        const b = value(right)
        const ordered =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b))
        return direction === 'asc' ? ordered : -ordered
      })
  }, [matching, staged, statuses, checking, preferences.sort, sources, presenceFilter])

  const total = items.filter((item) => belongsToPlatform(item, platform.id)).length
  const elsewhereCount = rows.filter((row) => row.presence === 'Elsewhere').length
  const sampleFoundAt = rows.find((row) => row.foundAt)?.foundAt
  const profileFolder = rows.length ? outputFolder(rows[0].item, profile) : ''

  const sortBy = (key: string) =>
    setPreferences((current) => ({
      ...current,
      sort:
        current.sort.key === key
          ? { key, direction: current.sort.direction === 'asc' ? 'desc' : 'asc' }
          : { key, direction: 'asc' },
    }))

  const moveColumn = (target: string) => {
    if (!draggedColumn || draggedColumn === target) return
    setPreferences((current) => {
      const next = current.columnOrder.filter((column) => column !== draggedColumn)
      next.splice(next.indexOf(target), 0, draggedColumn)
      return { ...current, columnOrder: next }
    })
    setDraggedColumn(null)
  }

  const cell = (column: string, row: Row) => {
    const { item } = row
    switch (column) {
      case 'presence':
        return (
          <td key={column}>
            <span
              className={`target-state ${row.presence.toLowerCase()}`}
              title={
                row.foundAt
                  ? `Already on the destination at ${row.foundAt}, which is not where this profile would write it.`
                  : undefined
              }
            >
              {row.presence === 'Elsewhere' ? 'On target' : row.presence}
            </span>
          </td>
        )
      case 'title':
        return (
          <td key={column}>
            <button
              className="table-title"
              title="Set the name this title is written under"
              onClick={() => setRenaming(item)}
            >
              <b>{item.canonicalTitle}</b>
              {item.displayTitle && (
                <small>
                  <Tag /> {item.displayTitle}
                </small>
              )}
            </button>
          </td>
        )
      case 'platform':
        return (
          <td key={column}>
            <select
              aria-label={`Platform for ${item.name}`}
              value={item.assignedPlatformId || platform.id}
              onChange={(event) => assignPlatform(item.id, event.target.value)}
            >
              {platforms.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </td>
        )
      case 'format': {
        const compatible = isFirmwareCompatible(
          forProfile(item, platform.id),
          profile.firmwareId,
        )
        return (
          <td key={column}>
            <span
              className={compatible ? 'compatible' : 'incompatible'}
              title={
                compatible
                  ? undefined
                  : `${requireFirmware(profile.firmwareId).name} does not list .${item.extension} for this platform.`
              }
            >
              .{item.extension}
            </span>
          </td>
        )
      }
      case 'size':
        return <td key={column}>{formatBytes(item.size)}</td>
      case 'location':
        return (
          <td key={column} className="location" title={item.path}>
            {row.location}
          </td>
        )
      default:
        return (
          <td key={column}>
            <button
              className="row-action"
              disabled={row.staged}
              title={row.staged ? 'Already in this profile' : `Add to ${profile.name}`}
              onClick={() => {
                // An ambiguous format is committed to this profile's platform
                // at the moment it is added, so the plan is never a guess.
                if (!item.assignedPlatformId) assignPlatform(item.id, platform.id)
                addToCollection(forProfile(item, platform.id))
              }}
            >
              {row.staged ? <Check /> : <ListPlus />}
            </button>
          </td>
        )
    }
  }

  return (
    <div className="library-layout">
      <section className="panel library-sidebar">
        <div className="profile">
          <p className="eyebrow">{platform.family} profile</p>
          <h2>{platform.name}</h2>
          <h3>Accepted by {requireFirmware(profile.firmwareId).name}</h3>
          <div className="chips">
            {accepted.length ? (
              accepted.map((format) => <span key={format}>{format}</span>)
            ) : (
              <span className="incompatible">none directly</span>
            )}
          </div>
          {convertible.length > 0 && (
            <p className="mode-note">
              {convertible.join(', ')} {convertible.length === 1 ? 'is a' : 'are'}{' '}
              {platform.name} format{convertible.length === 1 ? '' : 's'} this firmware
              cannot load directly. Convert to .hfe first.
            </p>
          )}
          <h3>Firmware for this machine</h3>
          <div className="chips">
            {platform.firmwareIds.map((id) => (
              <span key={id}>{requireFirmware(id).name}</span>
            ))}
          </div>
          <h3>Local sources</h3>
          <div className="managed-list">
            {sources.map((source) => {
              const chosen = selectedSources.includes(source.path)
              return (
              <div key={source.id} className={chosen ? 'selected' : ''}>
                <button
                  className="source-select"
                  aria-pressed={chosen}
                  title={`${source.path}\nShow only this source, or combine it with others`}
                  onClick={() =>
                    setSelectedSources((current) =>
                      current.includes(source.path)
                        ? current.filter((path) => path !== source.path)
                        : [...current, source.path],
                    )
                  }
                >
                  <b>{source.name}</b>
                  <small>
                    {countBySource.get(source.path) || 0} {platform.name} titles
                  </small>
                </button>
                <button
                  disabled={Boolean(busySourceId)}
                  title={`Re-index ${source.name} and its subfolders`}
                  onClick={() => refreshLocation(source)}
                >
                  <RefreshCw className={busySourceId === source.id ? 'spinning' : ''} />
                </button>
                <button title="Rename source" onClick={() => setEditing(source)}>
                  <Pencil />
                </button>
                <button
                  title="Remove source and its indexed titles"
                  onClick={() => removeLocation(source)}
                >
                  <Trash2 />
                </button>
              </div>
              )
            })}
            {!sources.length && <p>No source locations added</p>}
          </div>
          {selectedSources.length > 0 && (
            <button
              className="button secondary compact"
              onClick={() => setSelectedSources([])}
            >
              Show all {sources.length} sources
            </button>
          )}
        </div>
        <button className="button" onClick={addLocation}>
          <FolderOpen />
          Add location
        </button>
        {status && <InlineStatus kind={status.kind}>{status.text}</InlineStatus>}
      </section>

      <section className="panel library-results">
        <div className="library-toolbar">
          <div>
            <h2>{platform.name} titles</h2>
            <p>
              {rows.length === total
                ? `${total} title${total === 1 ? '' : 's'}`
                : `${rows.length} of ${total} titles`}
              {selectedSources.length
                ? ` · ${selectedSources.length} source${selectedSources.length === 1 ? '' : 's'}`
                : ''}{' '}
              · {requireFirmware(profile.firmwareId).name}
            </p>
          </div>
          <div className="coverage-filter" role="group" aria-label="Show titles by presence">
            {PRESENCE_FILTERS.map(([value, label]) => (
              <button
                key={value}
                className={presenceFilter === value ? 'active' : ''}
                aria-pressed={presenceFilter === value}
                disabled={checking && value !== 'all'}
                onClick={() => setPresenceFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="search">
            <Search />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter titles"
            />
          </div>
        </div>
        {elsewhereCount > 0 && (
          <div className="profile-mismatch">
            <b>
              {elsewhereCount} of these titles {elsewhereCount === 1 ? 'is' : 'are'} already
              on the destination, filed somewhere else
            </b>
            <span>
              Matched on contents, so the names and folders do not have to agree
              {sampleFoundAt ? <> — one of them is at <code>{sampleFoundAt}</code></> : null}.
              This profile would write them to <code>{profileFolder || 'the root'}/</code>{' '}
              using {profile.naming === 'oled' ? 'shortened OLED' : 'original'} names, which
              would make a second copy. Change its layout and naming to match the
              destination and they will show as already in place.
            </span>
          </div>
        )}
        {fingerprinting && (
          <InlineStatus kind="info">
            Reading contents to identify titles: {fingerprinting.done} of{' '}
            {fingerprinting.total}. Each file is read once and remembered, so this only
            happens again when a file changes.
          </InlineStatus>
        )}
        <div className="table-wrap">
          <table className="library-table">
            <thead>
              <tr>
                {preferences.columnOrder.map((column) => (
                  <th
                    key={column}
                    draggable
                    onDragStart={() => setDraggedColumn(column)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => moveColumn(column)}
                    className={preferences.sort.key === column ? 'sorted' : ''}
                  >
                    {column === 'action' ? null : (
                      <button
                        className="table-sort"
                        onClick={() => sortBy(column)}
                        title="Sort; drag to reorder columns"
                      >
                        {COLUMN_LABELS[column]}
                        {preferences.sort.key === column ? (
                          <span aria-hidden="true">
                            {preferences.sort.direction === 'asc' ? '↑' : '↓'}
                          </span>
                        ) : null}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.item.id}>
                  {preferences.columnOrder.map((column) => cell(column, row))}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <Empty
              title={
                !items.length
                  ? 'No titles indexed yet'
                  : presenceFilter !== 'all'
                    ? `No ${platform.name} titles are ${presenceFilter === 'present' ? 'on the target' : 'missing from the target'}`
                    : selectedSources.length
                      ? 'No titles from the selected sources'
                      : 'No matching titles'
              }
              action={items.length ? undefined : 'Add location'}
              run={items.length ? undefined : addLocation}
            />
          )}
        </div>
      </section>

      {renaming && (
        <DisplayNameDialog
          item={renaming}
          profile={profile}
          close={() => setRenaming(null)}
          save={(alias) => {
            setDisplayTitle(renaming.id, alias)
            setRenaming(null)
          }}
        />
      )}

      {editing && (
        <Modal title="Edit source" onClose={() => setEditing(null)}>
          <label>
            Nickname
            <input
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
          </label>
          <label>
            Folder
            <input readOnly value={editing.path} />
          </label>
          <button
            className="button"
            disabled={!editing.name.trim()}
            onClick={() => {
              renameLocation({ ...editing, name: editing.name.trim() })
              setEditing(null)
            }}
          >
            <Check />
            Save source
          </button>
        </Modal>
      )}
    </div>
  )
}

/**
 * Sets the name a title is written under, without touching the library's own
 * record of what it is called.
 *
 * Shown alongside a live preview of the resulting path, because the value of an
 * alias is entirely in what appears on the drive's display.
 */
function DisplayNameDialog({
  item,
  profile,
  close,
  save,
}: {
  item: MediaItem
  profile: Profile
  close: () => void
  save: (alias: string) => void
}) {
  const [alias, setAlias] = useState(item.displayTitle ?? '')
  const preview = outputFileName({ ...item, displayTitle: alias }, profile)
  const folder = outputFolder(item, profile)

  return (
    <Modal title="Name for the drive display" onClose={close}>
      <label>
        Library title
        <input readOnly value={item.canonicalTitle} />
      </label>
      <label>
        Display name
        <input
          autoFocus
          value={alias}
          placeholder={outputFileName({ ...item, displayTitle: undefined }, profile)}
          onChange={(event) => setAlias(event.target.value)}
        />
      </label>
      <p className="mode-note">
        Leave it empty to go back to the generated name. The library keeps the original
        either way, so nothing is lost.
      </p>
      <p className="feed-format">
        Will be written as <code>{folder ? `${folder}/${preview}` : preview}</code>
      </p>
      <button className="button" onClick={() => save(alias)}>
        <Check />
        Save name
      </button>
    </Modal>
  )
}
