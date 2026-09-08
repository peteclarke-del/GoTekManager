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
  Wand2,
} from 'lucide-react'
import {
  BulkBar,
  SelectAllCell,
  SelectCell,
  SelectColumns,
} from '../../components/BulkSelection'
import { Empty, InlineStatus } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { BulkAddDialog } from './BulkAddDialog'
import { acceptedFormats, platforms, requireFirmware, type Platform } from '../../domain/catalog'
import { categories } from '../../domain/categories'
import {
  elideMiddle,
  forProfile,
  formatBytes,
  isFirmwareCompatible,
  namingLabel,
  outputFileName,
  outputFolder,
  setIndexOf,
  SINGLE_DISC,
  type SetPosition,
} from '../../domain/media'
import { relativeTo } from '../../domain/paths'
import {
  isOnTarget,
  PRESENCE_BY_STATUS,
  PRESENCE_ORDER,
  type Presence,
} from '../../domain/presence'
import type { MediaItem, Profile, SourceLocation } from '../../domain/types'
import { useFingerprintProgress } from '../../hooks/useFingerprintProgress'
import { useRowSelection } from '../../hooks/useRowSelection'
import { PAGE_SIZE } from '../../hooks/usePagedRows'
import { useLibraryPage } from '../../hooks/useLibraryPage'
import { useTargetPresence } from '../../hooks/useTargetPresence'
import { useTitleRoom } from '../../hooks/useTitleRoom'
import type { TablePreferences } from '../../state/useWorkspace'

/** Which titles to show, by whether the destination already holds them. */
type PresenceFilter = 'all' | 'missing' | 'present'

const PRESENCE_FILTERS: Array<[PresenceFilter, string]> = [
  ['all', 'All'],
  ['missing', 'Not on target'],
  ['present', 'On target'],
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
  sources,
  collection,
  addLocation,
  reindexSources,
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
  sources: SourceLocation[]
  collection: MediaItem[]
  addLocation: () => void
  /** Re-indexes a set of sources, used by the scan of everything. */
  reindexSources: (chosen: SourceLocation[]) => Promise<void>
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
  /** Whether the scan of every source is open. */
  const [scanning, setScanning] = useState(false)
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null)
  const fingerprinting = useFingerprintProgress()
  // How much of a name the title column can hold, which changes with the window.
  const titleRoom = useTitleRoom()

  const accepted = useMemo(
    () => acceptedFormats(platform.id, profile.firmwareId),
    [platform.id, profile.firmwareId],
  )
  // Formats the machine uses that this firmware cannot read from the stick.
  const convertible = platform.formats.filter((format) => !accepted.includes(format))

  // How many rows have been asked for. "Show more" asks for more of them
  // rather than drawing more of a list already in hand.
  const [shown, setShown] = useState(PAGE_SIZE)
  useEffect(() => {
    setShown(PAGE_SIZE)
  }, [platform.id, query, selectedSources, preferences.sort])

  // The library is not in the window, so the filter, the order and the page are
  // the database's work. What comes back is what the table draws, plus the
  // counts that describe everything it does not.
  const page = useLibraryPage({
    platformId: platform.id,
    sources: selectedSources,
    search: query,
    sort: preferences.sort.key,
    descending: preferences.sort.direction === 'desc',
    limit: shown,
  })
  const matching = page.rows

  /** How many titles each source contributes for this platform. */
  const countBySource = useMemo(
    () => new Map(Object.entries(page.bySource)),
    [page.bySource],
  )

  const { statuses, checking, checked, comparable, askForCheck } = useTargetPresence(
    profile,
    matching,
    platform.id,
  )

  const staged = useMemo(() => new Set(collection.map((item) => item.id)), [collection])
  const sourceName = (item: MediaItem) => {
    const source = sources.find((entry) => entry.path === item.source)
    const nickname = source?.name || 'Source'
    return `${nickname}:/${relativeTo(item.source, item.path) || item.name}`
  }

  const rows = useMemo<Row[]>(() => {
    const { key, direction } = preferences.sort
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
      // Every other order is the database's, applied to the whole library
      // before this page of it was taken. Presence is not something the
      // database knows — it is the answer to a scan of the drive — so sorting
      // by it orders the rows on screen.
      .sort((left, right) =>
        key === 'presence'
          ? (PRESENCE_ORDER.indexOf(left.presence) -
              PRESENCE_ORDER.indexOf(right.presence)) *
            (direction === 'asc' ? 1 : -1)
          : 0,
      )
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
  const visible = rows
  const remaining = Math.max(0, page.total - page.rows.length)
  const showMore = () => setShown((count) => count + PAGE_SIZE)
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
  const stageItems = (chosen: MediaItem[]) => {
    // Judged against the *library's* record, never against the copy handed in.
    // A scan hands back titles already read as belonging to this machine, so
    // asking the copy whether it has a platform always says yes and the library
    // row keeps none. Collections are stored as ids, so the assignment is lost
    // on the next read and every staged title comes back a format this drive
    // cannot load — a full stick that plans as nothing to add.
    const held = new Map(matching.map((item) => [item.id, item]))
    const unassigned = chosen
      .filter((item) => !held.get(item.id)?.assignedPlatformId)
      .map((item) => item.id)
    if (unassigned.length) assignPlatform(unassigned, platform.id)
    addToCollection(chosen.map((item) => forProfile(item, platform.id)))
    selection.clear()
  }

  const stage = (chosen: Row[]) => stageItems(chosen.map((row) => row.item))

  const unstage = (chosen: Row[]) => {
    removeFromCollection(chosen.map((row) => row.item.id))
    selection.clear()
  }

  const total = page.total
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
              <b>{elideMiddle(item.canonicalTitle, titleRoom)}</b>
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
        <button
          className="button secondary"
          disabled={!sources.length}
          title={
            sources.length
              ? `Scan every source and add everything matching a filter to ${profile.name}`
              : 'Add a source location first'
          }
          onClick={() => setScanning(true)}
        >
          <Wand2 />
          Scan all sources
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
              {sampleFoundAt ? <>, one of them is at <code>{sampleFoundAt}</code></> : null}.
              This profile would write them to <code>{profileFolder || 'the root'}/</code>{' '}
              using {namingLabel(profile.naming)} names, which
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
              every one, which for a library this size on a network share takes minutes.
              Adding titles and writing them does not need it.
            </span>
            <button
              className="button secondary compact"
              disabled={checking}
              onClick={askForCheck}
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
          {remaining > 0 && (
            <div className="table-more">
              <span>
                Showing {visible.length.toLocaleString()} of {rows.length.toLocaleString()}{' '}
                matching titles
              </span>
              <button className="button secondary compact" onClick={showMore}>
                Show {Math.min(PAGE_SIZE, remaining).toLocaleString()} more
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
                !total
                  ? 'No titles indexed yet'
                  : profileFilter !== 'all'
                    ? `No ${platform.name} titles are ${profileFilter === 'staged' ? `in ${profile.name}` : `outside ${profile.name}`}`
                    : presenceFilter !== 'all'
                      ? `No ${platform.name} titles are ${presenceFilter === 'present' ? 'on the target' : 'missing from the target'}`
                      : selectedSources.length
                        ? 'No titles from the selected sources'
                        : 'No matching titles'
              }
              action={total ? undefined : 'Add location'}
              run={total ? undefined : addLocation}
            />
          )}
        </div>
      </section>

      {scanning && (
        <BulkAddDialog
          profile={profile}
          platform={platform}
          sources={sources}
          staged={collection}
          presence={statuses}
          reindexSources={reindexSources}
          assignCategory={assignCategory}
          stage={stageItems}
          close={() => setScanning(false)}
        />
      )}

      {/* The set index is worked out here rather than on every render: it walks
          the whole library, and only this preview needs it. */}
      {renaming && (
        <DisplayNameDialog
          item={renaming}
          profile={profile}
          set={setIndexOf(comparable).get(renaming.id) ?? SINGLE_DISC}
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
  set,
  close,
  save,
}: {
  item: MediaItem
  profile: Profile
  set: SetPosition
  close: () => void
  save: (alias: string) => void
}) {
  const [alias, setAlias] = useState(item.displayTitle ?? '')
  const preview = outputFileName({ ...item, displayTitle: alias }, profile, set)
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
          placeholder={outputFileName({ ...item, displayTitle: undefined }, profile, set)}
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
