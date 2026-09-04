import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  FolderOpen,
  FolderTree,
  ListMinus,
  ListPlus,
  Pencil,
  RefreshCw,
  Search,
  Tag,
  Trash2,
} from 'lucide-react'
import {
  BulkBar,
  SelectAllCell,
  SelectCell,
  SelectColumns,
} from '../../components/BulkSelection'
import { Empty, InlineStatus } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { acceptedFormats, platforms, requireFirmware, type Platform } from '../../domain/catalog'
import { categories } from '../../domain/categories'
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
import { useRowSelection } from '../../hooks/useRowSelection'
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
type Presence =
  | 'Unchecked'
  | 'Checking'
  | 'New'
  | 'Identical'
  | 'Different'
  | 'Elsewhere'
  | 'Unavailable'

/**
 * How many titles are compared with the destination without being asked.
 *
 * Presence is decided by contents, which means reading every title: exact, and
 * not free. For a few hundred that is a moment. For a few thousand — a library
 * of archived titles on a network share, say — it is minutes, and doing it the
 * instant the step opens looks like the application has hung. Beyond this many,
 * the check is offered rather than taken.
 */
const AUTOMATIC_CHECK_LIMIT = 500

/**
 * How many titles the table draws at once.
 *
 * Every row carries a platform and a category to choose from, which is some
 * thirty elements of markup; a library of a few thousand is a few hundred
 * thousand of them, and building that many takes tens of seconds during which
 * nothing on screen responds. A page of them draws in a moment, and the rest
 * are one button away — or, more usually, one search away.
 */
const PAGE_SIZE = 150

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
  'Unchecked',
]

/** Which titles to show, by whether this profile already stages them. */
type ProfileFilter = 'all' | 'staged' | 'unstaged'

const PROFILE_FILTERS: Array<[ProfileFilter, string]> = [
  ['all', 'All'],
  ['staged', 'In profile'],
  ['unstaged', 'Not in profile'],
]

const COLUMN_LABELS: Record<string, string> = {
  presence: 'Target',
  title: 'Title',
  platform: 'Platform',
  category: 'Category',
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
  assignCategory,
  setDisplayTitle,
  addToCollection,
  removeFromCollection,
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
  assignPlatform: (itemIds: string[], platformId: string) => void
  assignCategory: (itemIds: string[], categoryId: string) => void
  setDisplayTitle: (itemId: string, displayTitle: string) => void
  addToCollection: (items: MediaItem[]) => void
  removeFromCollection: (itemIds: string[]) => void
  preferences: TablePreferences
  setPreferences: React.Dispatch<React.SetStateAction<TablePreferences>>
  status: { kind: 'success' | 'error' | 'info'; text: string } | null
  busySourceId: string
}) {
  const [query, setQuery] = useState('')
  /** Source paths to narrow the table to. Empty means every source. */
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [presenceFilter, setPresenceFilter] = useState<PresenceFilter>('all')
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>('all')
  const [editing, setEditing] = useState<SourceLocation | null>(null)
  const [renaming, setRenaming] = useState<MediaItem | null>(null)
  const [statuses, setStatuses] = useState<Record<string, TargetFileStatus>>({})
  const [checking, setChecking] = useState(false)
  /** Set once the user asks for a comparison too large to run unprompted. */
  const [checkAsked, setCheckAsked] = useState(false)
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null)
  /** How many of the matching titles are drawn. */
  const [shown, setShown] = useState(PAGE_SIZE)
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
    setShown(PAGE_SIZE)
  }, [query, selectedSources, presenceFilter, profileFilter, platform.id, profile.id])

  const automatic = comparable.length <= AUTOMATIC_CHECK_LIMIT
  const checked = automatic || checkAsked

  // A different destination is a different answer, so an answer already given
  // is not carried across to one that has not been asked for.
  useEffect(() => {
    setCheckAsked(false)
    setStatuses({})
  }, [profile.id, platform.id])

  useEffect(() => {
    let active = true
    if (!comparable.length || !checked) {
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
    checked,
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
        case 'category':
          return row.item.category || ''
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
          : !checked
            ? 'Unchecked'
            : PRESENCE_BY_STATUS[statuses[item.path]?.status] || 'Checking',
        foundAt: statuses[item.path]?.foundAt,
        location: sourceName(item),
      }))
      // While the contents are still being read nothing is known yet, so the
      // filter is held back rather than emptying the table as it works.
      .filter((row) =>
        presenceFilter === 'all' || checking || !checked
          ? true
          : (presenceFilter === 'present') === isOnTarget(row.presence),
      )
      .filter((row) =>
        profileFilter === 'all' ? true : (profileFilter === 'staged') === row.staged,
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
  }, [
    matching,
    staged,
    statuses,
    checking,
    checked,
    preferences.sort,
    sources,
    presenceFilter,
    profileFilter,
  ])

  // The selection follows the table: filtering a ticked title away unticks it,
  // so a bulk action can only ever reach what is on screen.
  const visible = useMemo(() => rows.slice(0, shown), [rows, shown])
  const rowIds = useMemo(() => visible.map((row) => row.item.id), [visible])
  const selection = useRowSelection(rowIds)
  const picked = selection.chosen(visible, (row) => row.item.id)
  const addable = picked.filter((row) => !row.staged)
  const removable = picked.filter((row) => row.staged)

  /**
   * Stages titles against this profile.
   *
   * An ambiguous format is committed to this profile's platform at the moment
   * it is added, so the plan is never a guess about what a .dsk holds.
   */
  const stage = (chosen: Row[]) => {
    const unassigned = chosen
      .filter((row) => !row.item.assignedPlatformId)
      .map((row) => row.item.id)
    if (unassigned.length) assignPlatform(unassigned, platform.id)
    addToCollection(chosen.map((row) => forProfile(row.item, platform.id)))
    selection.clear()
  }

  const unstage = (chosen: Row[]) => {
    removeFromCollection(chosen.map((row) => row.item.id))
    selection.clear()
  }

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
          <td key={column} className={column}>
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
          <td key={column} className={column}>
            <button
              className="table-title"
              // The name first: a column can always be too narrow for a long
              // one, and a tooltip that explains the button instead of naming
              // the file leaves nowhere at all to read it.
              title={`${item.canonicalTitle}\n\nClick to set the name this title is written under`}
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
          <td key={column} className={column}>
            <select
              aria-label={`Platform for ${item.name}`}
              value={item.assignedPlatformId || platform.id}
              onChange={(event) => assignPlatform([item.id], event.target.value)}
            >
              {platforms.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </td>
        )
      case 'category':
        return (
          <td key={column} className={column}>
            <select
              aria-label={`Category for ${item.name}`}
              value={item.category || ''}
              onChange={(event) => assignCategory([item.id], event.target.value)}
            >
              <option value="">Unsorted</option>
              {categories.map((entry) => (
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
          <td key={column} className={column}>
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
        return (
          <td key={column} className={column}>
            {formatBytes(item.size)}
          </td>
        )
      case 'location':
        return (
          <td key={column} className={column} title={item.path}>
            {row.location}
          </td>
        )
      default:
        // Adding and taking back out are the same button, because a title that
        // can be put into a profile has to be as easy to take out again.
        return (
          <td key={column} className={column}>
            <button
              className={row.staged ? 'row-action staged' : 'row-action'}
              title={
                row.staged
                  ? `Remove ${item.canonicalTitle} from ${profile.name}`
                  : `Add ${item.canonicalTitle} to ${profile.name}`
              }
              onClick={() => (row.staged ? unstage([row]) : stage([row]))}
            >
              {row.staged ? <ListMinus /> : <ListPlus />}
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
              · {collection.length} in {profile.name} · {requireFirmware(profile.firmwareId).name}
            </p>
          </div>
          <div className="coverage-filter" role="group" aria-label="Show titles by presence">
            {PRESENCE_FILTERS.map(([value, label]) => (
              <button
                key={value}
                className={presenceFilter === value ? 'active' : ''}
                aria-pressed={presenceFilter === value}
                disabled={(checking || !checked) && value !== 'all'}
                title={
                  checked
                    ? undefined
                    : 'Check these titles against the target to filter by it'
                }
                onClick={() => setPresenceFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="coverage-filter"
            role="group"
            aria-label="Show titles by whether this profile stages them"
          >
            {PROFILE_FILTERS.map(([value, label]) => (
              <button
                key={value}
                className={profileFilter === value ? 'active' : ''}
                aria-pressed={profileFilter === value}
                onClick={() => setProfileFilter(value)}
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
        {!checked && comparable.length > 0 && (
          <div className="source-status info target-check">
            <span>
              <b>{comparable.length} titles are not checked against {profile.name}.</b> Whether
              a title is already there is decided by its contents, so answering means reading
              every one — minutes, for a library this size on a network share. Adding titles
              and writing them does not need it.
            </span>
            <button
              className="button secondary compact"
              disabled={checking}
              onClick={() => setCheckAsked(true)}
            >
              <RefreshCw className={checking ? 'spinning' : ''} />
              Check against the target
            </button>
          </div>
        )}
        {fingerprinting && (
          <InlineStatus kind="info">
            Reading contents to identify titles: {fingerprinting.done} of{' '}
            {fingerprinting.total}. Each file is read once and remembered, so this only
            happens again when a file changes.
          </InlineStatus>
        )}
        <BulkBar selection={selection} noun="titles">
          <button
            className="button compact"
            disabled={!addable.length}
            title={`Add every selected title that is not already in ${profile.name}`}
            onClick={() => stage(addable)}
          >
            <ListPlus />
            Add {addable.length} to {profile.name}
          </button>
          <button
            className="button secondary compact"
            disabled={!removable.length}
            title={`Take every selected title back out of ${profile.name}`}
            onClick={() => unstage(removable)}
          >
            <ListMinus />
            Remove {removable.length} from {profile.name}
          </button>
          <label className="bulk-category">
            <FolderTree />
            <span>Category</span>
            <select
              aria-label={`Set the category of ${picked.length} selected titles`}
              value=""
              onChange={(event) => {
                assignCategory(
                  picked.map((row) => row.item.id),
                  event.target.value === 'clear' ? '' : event.target.value,
                )
                selection.clear()
              }}
            >
              <option value="" disabled>
                Set for {picked.length}…
              </option>
              {categories.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
              <option value="clear">Unsorted</option>
            </select>
          </label>
        </BulkBar>

        <div className="table-wrap">
          <table className="library-table">
            <SelectColumns />
            <thead>
              <tr>
                <SelectAllCell
                  selection={selection}
                  label={`Select all ${visible.length} titles shown`}
                />
                {preferences.columnOrder.map((column) => (
                  <th
                    key={column}
                    draggable
                    onDragStart={() => setDraggedColumn(column)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => moveColumn(column)}
                    className={
                      preferences.sort.key === column ? `${column} sorted` : column
                    }
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
              {visible.map((row) => (
                <tr key={row.item.id} className={row.staged ? 'staged' : ''}>
                  <SelectCell
                    selection={selection}
                    id={row.item.id}
                    label={`Select ${row.item.canonicalTitle}`}
                  />
                  {preferences.columnOrder.map((column) => cell(column, row))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > visible.length && (
            <div className="table-more">
              <span>
                Showing {visible.length} of {rows.length} matching titles
              </span>
              <button
                className="button secondary compact"
                onClick={() => setShown((count) => count + PAGE_SIZE)}
              >
                Show {Math.min(PAGE_SIZE, rows.length - visible.length)} more
              </button>
              <button
                className="button compact"
                title={`Add every matching title to ${profile.name}, drawn or not`}
                onClick={() => stage(rows.filter((row) => !row.staged))}
              >
                <ListPlus />
                Add all {rows.filter((row) => !row.staged).length} to {profile.name}
              </button>
            </div>
          )}
          {!rows.length && (
            <Empty
              title={
                !items.length
                  ? 'No titles indexed yet'
                  : profileFilter !== 'all'
                    ? `No ${platform.name} titles are ${profileFilter === 'staged' ? `in ${profile.name}` : `outside ${profile.name}`}`
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
