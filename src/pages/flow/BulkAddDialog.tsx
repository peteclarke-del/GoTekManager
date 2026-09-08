/**
 * Filling a profile from every local source in one pass.
 *
 * Three questions, in the order somebody actually asks them: which sources,
 * what counts as worth having, and — before anything at all is staged — what
 * that would actually add and where it would land. Nothing here writes to the
 * media; it stages titles against the profile exactly as ticking them by hand
 * does, and the existing Verify and Confirm steps still stand between the user
 * and the drive.
 */

import { useMemo, useState } from 'react'
import { FolderTree, ListPlus, RefreshCw, Wand2 } from 'lucide-react'
import { Modal } from '../../components/Modal'
import { InlineStatus } from '../../components/Feedback'
import { acceptedFormats, type Platform } from '../../domain/catalog'
import { categories, categoryFolderFor } from '../../domain/categories'
import {
  CLEAN_RELEASES,
  NO_CATEGORY,
  planBulkAdd,
  SCAN_PRESETS,
  type ScanFilter,
} from '../../domain/bulkAdd'
import { formatBytes, tagsOf } from '../../domain/media'
import { spokenLanguages } from '../../domain/tags'
import type { DevStatus, Distribution, DumpFlag } from '../../domain/tags'
import type { MediaItem, Profile, SourceLocation, TargetFileStatus } from '../../domain/types'
import { errorMessage } from '../../native/commands'
import { useAllItems } from '../../hooks/useAllItems'
import { useScanProgress } from '../../hooks/useScanProgress'

/** One selectable value, with how many titles in the library carry it. */
type Option = { value: string; label: string; count: number }

const DUMP_FLAG_LABELS: Record<DumpFlag, string> = {
  verified: 'verified good dump',
  fixed: 'fixed',
  alternate: 'alternate dump',
  trained: 'trained',
  translated: 'translated',
  cracked: 'cracked',
  hacked: 'hacked',
  modified: 'modified',
  pirate: 'pirate',
  overdump: 'overdump',
  underdump: 'underdump',
  bad: 'bad dump',
  virus: 'virus',
}

const DEV_STATUS_LABELS: Record<DevStatus, string> = {
  alpha: 'alpha',
  beta: 'beta',
  preview: 'preview',
  prototype: 'prototype',
  sample: 'sample',
  demo: 'playable demo',
}

const DISTRIBUTION_LABELS: Record<Distribution | 'commercial', string> = {
  commercial: 'commercial',
  pd: 'public domain',
  freeware: 'freeware',
  shareware: 'shareware',
  giftware: 'giftware',
  licenceware: 'licenceware',
  cardware: 'cardware',
  mailware: 'mailware',
}

/** The language filter's stand-in for a title that states no language at all. */
const UNTAGGED = 'untagged'

/**
 * A row of tick-able values.
 *
 * Every option carries how many titles in this library actually have it, so the
 * choice is made against the collection in front of the user rather than in the
 * abstract — there is no point excluding Norwegian releases from a library that
 * holds none.
 */
function OptionRow({
  legend,
  options,
  chosen,
  anyLabel,
  reset = 'all',
  onChange,
}: {
  legend: string
  options: Option[]
  /** `undefined` means every value, including ones not listed. */
  chosen: string[] | undefined
  anyLabel: string
  /**
   * What the leading button means, because the two are opposites.
   *
   * Most rows narrow from everything: no choice means every language. Two of
   * them widen from nothing: an empty list of unfinished builds means finished
   * releases only, and each tick lets one more kind in. Reading the second as
   * the first left "Finished releases only" permanently unlit and doing
   * nothing when pressed, because the list it would clear was empty already.
   */
  reset?: 'all' | 'none'
  onChange: (chosen: string[] | undefined) => void
}) {
  if (!options.length) return null
  const cleared = reset === 'all' ? chosen === undefined : !chosen?.length
  return (
    <fieldset className="scan-options">
      <legend>{legend}</legend>
      <button
        type="button"
        className={cleared ? 'chip active' : 'chip'}
        aria-pressed={cleared}
        onClick={() => onChange(reset === 'all' ? undefined : [])}
      >
        {anyLabel}
      </button>
      {options.map((option) => {
        const on = chosen?.includes(option.value) ?? false
        return (
          <button
            key={option.value}
            type="button"
            className={on ? 'chip active' : 'chip'}
            aria-pressed={on}
            onClick={() =>
              onChange(
                on
                  ? (chosen ?? []).filter((value) => value !== option.value)
                  : [...(chosen ?? []), option.value],
              )
            }
          >
            {option.label} <small>{option.count}</small>
          </button>
        )
      })}
    </fieldset>
  )
}

function tally(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  return counts
}

function optionsFrom(
  counts: Map<string, number>,
  label: (value: string) => string,
): Option[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

export function BulkAddDialog({
  profile,
  platform,
  sources,
  staged,
  presence,
  reindexSources,
  assignCategory,
  stage,
  close,
}: {
  profile: Profile
  platform: Platform
  /** The whole library; this narrows it to the machine being prepared. */
  sources: SourceLocation[]
  /** What this profile already holds, so a second copy of a disc is refused. */
  staged: readonly MediaItem[]
  presence: Record<string, TargetFileStatus>
  /** Re-indexes the chosen sources before they are scanned. */
  reindexSources: (chosen: SourceLocation[]) => Promise<void>
  assignCategory: (itemIds: string[], categoryId: string) => void
  stage: (items: MediaItem[]) => void
  close: () => void
}) {
  const [filter, setFilter] = useState<ScanFilter>(CLEAN_RELEASES)
  const [preset, setPreset] = useState('clean')
  // Off by default. Re-reading every source takes minutes on a network share,
  // and opening a dialog is not consent to start it — the button is right
  // there, and the counts below say how stale the library is.
  const [rescan, setRescan] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [failure, setFailure] = useState('')
  /** A category to give everything the scan could not sort, before staging. */
  const [sortUnsorted, setSortUnsorted] = useState('')
  // Re-reading every source is the slowest thing this dialog does, so it says
  // where it has got to rather than sitting on one unchanging sentence.
  const progress = useScanProgress()

  // Read here rather than handed in: the library is not carried about any
  // more, and this is the one screen that genuinely wants all of it.
  const library = useAllItems(platform.id)
  const mine = library.items

  /** What this library actually contains, which is what the choices offer. */
  const available = useMemo(() => {
    const tags = mine.map((item) => tagsOf(item))
    // The same reading the filter applies, so a choice offering "German, 3,593"
    // and a filter that then keeps them all cannot happen.
    const languages = tally(
      tags.flatMap((entry) => {
        const spoken = spokenLanguages(entry)
        if (spoken.length) return spoken
        return entry.multiLanguage ? [] : [UNTAGGED]
      }),
    )
    return {
      languages: optionsFrom(languages, (value) =>
        value === UNTAGGED ? 'states none' : value,
      ),
      devStatus: optionsFrom(
        tally(tags.flatMap((entry) => (entry.devStatus ? [entry.devStatus] : []))),
        (value) => DEV_STATUS_LABELS[value as DevStatus] ?? value,
      ),
      dumpFlags: optionsFrom(
        tally(tags.flatMap((entry) => entry.dumpFlags.filter((flag) => flag !== 'verified'))),
        (value) => DUMP_FLAG_LABELS[value as DumpFlag] ?? value,
      ),
      distribution: optionsFrom(
        tally(tags.map((entry) => entry.distribution ?? 'commercial')),
        (value) => DISTRIBUTION_LABELS[value as Distribution] ?? value,
      ),
      regions: optionsFrom(tally(tags.flatMap((entry) => entry.regions)), (value) => value),
      categories: optionsFrom(
        tally(mine.map((item) => item.category || NO_CATEGORY)),
        (value) =>
          value === NO_CATEGORY
            ? 'unsorted'
            : (categories.find((entry) => entry.id === value)?.name ?? value),
      ),
    }
  }, [mine])

  // The preview reflects the category the user would give the unsorted titles,
  // because seeing them land in Unsorted and then reading that they will not is
  // worse than not showing it at all.
  const previewed = useMemo(
    () =>
      sortUnsorted
        ? mine.map((item) => (item.category ? item : { ...item, category: sortUnsorted }))
        : mine,
    [mine, sortUnsorted],
  )

  const plan = useMemo(
    () => planBulkAdd(previewed, profile, platform.id, filter, { presence, staged }),
    [previewed, profile, platform.id, filter, presence, staged],
  )

  const accepted = acceptedFormats(platform.id, profile.firmwareId)
  const room = profile.destination.availableBytes
  const tooBig = room !== undefined && plan.totalBytes > room

  // Any change to a control is the user's own filter, whatever it started as.
  const change = (next: Partial<ScanFilter>) => {
    setFilter((current) => ({ ...current, ...next }))
    setPreset('custom')
  }

  const applyPreset = (id: string) => {
    const chosen = SCAN_PRESETS.find((entry) => entry.id === id)
    if (!chosen) return
    setPreset(id)
    setFilter({ ...chosen.filter, sourcePaths: filter.sourcePaths })
  }

  const runScan = async () => {
    setFailure('')
    setScanning(true)
    try {
      const chosen = filter.sourcePaths.length
        ? sources.filter((source) => filter.sourcePaths.includes(source.path))
        : sources
      await reindexSources(chosen)
    } catch (reason) {
      setFailure(errorMessage(reason))
    } finally {
      setScanning(false)
    }
  }

  const apply = () => {
    // The preview already shows these titles under the category they are about
    // to be given, so the library is told about it too rather than the two
    // disagreeing the moment the dialog closes.
    const held = new Map(mine.map((item) => [item.id, item.category]))
    const toSort = sortUnsorted
      ? plan.included.filter((item) => !held.get(item.id)).map((item) => item.id)
      : []
    if (toSort.length) assignCategory(toSort, sortUnsorted)
    stage(plan.included)
    close()
  }

  return (
    <Modal
      title={`Add to ${profile.name} from all sources`}
      onClose={close}
      className="scan-modal"
    >
      <div className="scan-dialog">
        <section>
          <h3>Sources</h3>
          <div className="scan-sources">
            {sources.map((source) => {
              const on =
                !filter.sourcePaths.length || filter.sourcePaths.includes(source.path)
              const held = mine.filter((item) => item.source === source.path).length
              return (
                <label key={source.id} className="check-label">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const current = filter.sourcePaths.length
                        ? filter.sourcePaths
                        : sources.map((entry) => entry.path)
                      const next = on
                        ? current.filter((path) => path !== source.path)
                        : [...current, source.path]
                      change({
                        sourcePaths: next.length === sources.length ? [] : next,
                      })
                    }}
                  />
                  {source.name} <small>{held} {platform.name} titles</small>
                </label>
              )
            })}
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={rescan}
              onChange={(event) => setRescan(event.target.checked)}
            />
            Re-index these sources first
          </label>
          <button
            type="button"
            className="button secondary compact"
            disabled={scanning}
            onClick={() => void runScan()}
          >
            <RefreshCw className={scanning ? 'spinning' : ''} />
            Re-index now
          </button>
          {scanning && (
            <InlineStatus kind="info">
              <RefreshCw className="spinning" />{' '}
              {progress
                ? `Re-indexing: ${progress.found} found in ${progress.folders} folder${progress.folders === 1 ? '' : 's'} so far.`
                : 'Re-indexing every chosen source.'}{' '}
              A library on a network share takes minutes; nothing is staged until you
              confirm.
            </InlineStatus>
          )}
          {failure && <InlineStatus kind="error">{failure}</InlineStatus>}
        </section>

        <section>
          <h3>What to include</h3>
          <div className="scan-presets" role="group" aria-label="Filter presets">
            {SCAN_PRESETS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={preset === entry.id ? 'chip active' : 'chip'}
                aria-pressed={preset === entry.id}
                title={entry.summary}
                onClick={() => applyPreset(entry.id)}
              >
                {entry.name}
              </button>
            ))}
            {preset === 'custom' && <span className="chip active">Custom</span>}
          </div>

          <OptionRow
            legend="Languages"
            anyLabel="Any language"
            options={available.languages}
            chosen={
              filter.languages === 'any'
                ? undefined
                : [
                    ...filter.languages.include,
                    ...(filter.languages.includeUntagged ? [UNTAGGED] : []),
                  ]
            }
            onChange={(chosen) =>
              change({
                languages: chosen
                  ? {
                      include: chosen.filter((value) => value !== UNTAGGED),
                      includeUntagged: chosen.includes(UNTAGGED),
                    }
                  : 'any',
              })
            }
          />
          <OptionRow
            legend="Unfinished builds"
            anyLabel="Finished releases only"
            reset="none"
            options={available.devStatus}
            chosen={filter.devStatus}
            onChange={(chosen) => change({ devStatus: (chosen ?? []) as DevStatus[] })}
          />
          <OptionRow
            legend="Dumps to allow"
            anyLabel="Untouched dumps only"
            reset="none"
            options={available.dumpFlags}
            chosen={filter.dumpFlags}
            onChange={(chosen) => change({ dumpFlags: (chosen ?? []) as DumpFlag[] })}
          />
          <OptionRow
            legend="Published as"
            anyLabel="Any"
            options={available.distribution}
            chosen={filter.distribution === 'any' ? undefined : filter.distribution}
            onChange={(chosen) =>
              change({ distribution: (chosen as Distribution[] | undefined) ?? 'any' })
            }
          />
          <OptionRow
            legend="Regions"
            anyLabel="Any region"
            options={available.regions}
            chosen={filter.regions === 'any' ? undefined : filter.regions}
            onChange={(chosen) => change({ regions: chosen ?? 'any' })}
          />
          <OptionRow
            legend="Categories"
            anyLabel="Any category"
            options={available.categories}
            chosen={filter.categories === 'any' ? undefined : filter.categories}
            onChange={(chosen) => change({ categories: chosen ?? 'any' })}
          />

          <label className="check-label">
            <input
              type="checkbox"
              checked={filter.keepDiskSetsWhole}
              onChange={(event) => change({ keepDiskSetsWhole: event.target.checked })}
            />
            Keep multi-disc sets whole, and leave out any set missing a disc
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={filter.onePerTitle}
              onChange={(event) => change({ onePerTitle: event.target.checked })}
            />
            One copy of each title: the original first, then alternates
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={filter.acceptedFormatsOnly}
              onChange={(event) => change({ acceptedFormatsOnly: event.target.checked })}
            />
            Only formats this drive can load ({accepted.join(', ') || 'none directly'})
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={filter.onlyMissingFromTarget}
              onChange={(event) => change({ onlyMissingFromTarget: event.target.checked })}
            />
            Only titles the destination does not already hold
          </label>
        </section>

        <section>
          <h3>What this would add</h3>
          <p className="scan-headline">
            <b>
              {plan.included.length} title{plan.included.length === 1 ? '' : 's'}
            </b>{' '}
            of {plan.considered} indexed for {platform.name} · {formatBytes(plan.totalBytes)}
            {room !== undefined && <> of {formatBytes(room)} free</>}
          </p>
          {tooBig && (
            <InlineStatus kind="error">
              That is more than the destination has room for. Narrow the filter, or write it
              in more than one pass.
            </InlineStatus>
          )}

          <table className="scan-table">
            <thead>
              <tr>
                <th>Folder on the drive</th>
                <th>Titles</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {plan.byFolder.map((group) => (
                <tr key={group.folder}>
                  <td>
                    <code>{group.folder}</code>
                  </td>
                  <td>{group.items.length}</td>
                  <td>{formatBytes(group.bytes)}</td>
                </tr>
              ))}
              {!plan.byFolder.length && (
                <tr>
                  <td colSpan={3}>Nothing matches this filter yet.</td>
                </tr>
              )}
            </tbody>
          </table>

          {plan.unsorted.length > 0 && (
            <div className="scan-unsorted">
              <b>
                {plan.unsorted.length} of these have no category
                {profile.folderLayout === 'category' && (
                  <> and would go to <code>{categoryFolderFor(profile, undefined)}/</code></>
                )}
              </b>
              <label className="bulk-category">
                <FolderTree />
                <span>Give them all one category</span>
                <select
                  value={sortUnsorted}
                  onChange={(event) => setSortUnsorted(event.target.value)}
                >
                  <option value="">Leave them unsorted</option>
                  {categories.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {plan.compromised.length > 0 && (
            <details className="scan-detail">
              <summary>
                {plan.compromised.length} set{plan.compromised.length === 1 ? '' : 's'}{' '}
                finished with a disc your filter would have refused
              </summary>
              <p className="mode-note">
                Every copy of those discs carries something you asked to leave out, very
                often a crack, which is simply how most of this software circulated. The
                alternative was losing a game that plays perfectly well, so they were taken
                anyway.
              </p>
              <ul>
                {plan.compromised.slice(0, 20).map((set) => (
                  <li key={set.title}>
                    {set.title}: {set.discs.join(', ')}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {plan.incomplete.length > 0 && (
            <details className="scan-detail">
              <summary>
                {plan.incomplete.length} set{plan.incomplete.length === 1 ? '' : 's'} left out:
                no copy of a disc exists at all
              </summary>
              <ul>
                {plan.incomplete.slice(0, 20).map((set) => (
                  <li key={set.title}>
                    {set.title}, missing {set.missing.join(', ')}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {plan.mixed.length > 0 && (
            <details className="scan-detail">
              <summary>
                {plan.mixed.length} set{plan.mixed.length === 1 ? '' : 's'} built from more
                than one release
              </summary>
              <p className="mode-note">
                No single release held every disc, so each disc came from the best copy
                available. They work together in almost every case, but they were not dumped
                together.
              </p>
              <ul>
                {plan.mixed.slice(0, 20).map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            </details>
          )}

          {plan.renamed.length > 0 && (
            <details className="scan-detail">
              <summary>
                {plan.renamed.length} name{plan.renamed.length === 1 ? '' : 's'} kept apart
                from another
              </summary>
              <p className="mode-note">
                Two titles reduced to the same name, so the later one keeps enough of what
                the collection recorded to stay separate.
              </p>
              <ul>
                {plan.renamed.slice(0, 20).map((entry) => (
                  <li key={entry.relativePath}>
                    <code>{entry.relativePath}</code>, from {entry.name}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {plan.excluded.length > 0 && (
            <details className="scan-detail">
              <summary>
                {plan.excluded.reduce((total, group) => total + group.count, 0)} left out
              </summary>
              <ul>
                {plan.excluded.map((group) => (
                  <li key={group.reason}>
                    <b>{group.count}</b> {group.reason}: {group.examples.join(', ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <button
          className="button"
          disabled={!plan.included.length || scanning}
          onClick={apply}
        >
          {scanning ? <RefreshCw className="spinning" /> : <ListPlus />}
          Add {plan.included.length} to {profile.name}
        </button>
        <p className="mode-note">
          <Wand2 /> Nothing is written yet. These are staged against the profile, and the
          Verify and Confirm steps still stand between them and the drive.
        </p>
      </div>
    </Modal>
  )
}
