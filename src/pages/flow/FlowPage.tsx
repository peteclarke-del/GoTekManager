import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, FolderOpen, Globe2, Upload, X } from 'lucide-react'
import { ProgressDialog } from '../../components/Feedback'
import { requirePlatform } from '../../domain/catalog'
import {
  classifyMedia,
  formatBytes,
  isFirmwareCompatible,
  managedFormats,
  transferOperations,
} from '../../domain/media'
import { downloadSourceOf } from '../../domain/downloads'
import { basename } from '../../domain/paths'
import { upsertById } from '../../domain/records'
import { configFor } from '../../domain/firmwareConfig'
import { blockedTitles, summarisePlan } from '../../domain/plan'
import type {
  CachedDownload,
  DestinationEdit,
  MediaItem,
  Notice,
  OnlineProvider,
  OnlineTitle,
  SourceLocation,
  TransferPlan,
} from '../../domain/types'
import { useDirectoryBrowser } from '../../hooks/useDirectoryBrowser'
import { useTransferPlan } from '../../hooks/useTransferPlan'
import {
  chooseFolder,
  errorMessage,
  executeTransfer,
  firmwareConfigState,
  writeFirmwareConfig,
  scanFolder,
  type TransferRequest,
} from '../../native/commands'
import type { TablePreferences } from '../../state/useWorkspace'
import { isWritable, type Workspace, type WorkspaceAction } from '../../state/workspace'
import { ContentsStep } from './ContentsStep'
import { DriveConfiguration } from './DriveConfiguration'
import { LocalLibrary } from './LocalLibrary'
import { OnlineLibrary } from './OnlineLibrary'
import { ProfileStep } from './ProfileStep'
import { ResultTable, type ResultView } from './ResultTable'

/** What each kind of blocker means, in the words the user needs. */
const BLOCKER_EXPLANATIONS: Array<{
  kind: 'collision' | 'unavailable' | 'changed'
  label: string
  detail: string
}> = [
  {
    kind: 'collision',
    label: 'would overwrite another title:',
    detail:
      'two staged titles ending up with the same name on the drive. The first keeps the name, so taking the second out settles it.',
  },
  {
    kind: 'unavailable',
    label: 'cannot be found:',
    detail:
      'the file is no longer where the library indexed it — a download cleared from the cache, or a share no longer mounted.',
  },
  {
    kind: 'changed',
    label: 'changed since indexing:',
    detail: 'the file is not the size it was, so re-index that source before writing it.',
  },
]

type Step = 1 | 2 | 3 | 4 | 5 | 6
const STEP_LABELS = ['Profile', 'Contents', 'Sources', 'Verify', 'Confirm', 'Summary']

export type FlowPageProps = {
  workspace: Workspace
  dispatch: React.Dispatch<WorkspaceAction>
  collection: MediaItem[]
  removalPolicy: 'keep' | 'remove'
  providers: OnlineProvider[]
  setCustomProviders: React.Dispatch<React.SetStateAction<OnlineProvider[]>>
  preferences: TablePreferences
  setPreferences: React.Dispatch<React.SetStateAction<TablePreferences>>
  /** Whether indexing also converts images the drive cannot read. */
  convertIncompatible: boolean
  notify: (notice: Notice) => void
  manageProfiles: () => void
}

export function FlowPage({
  workspace,
  dispatch,
  collection,
  removalPolicy,
  providers,
  setCustomProviders,
  preferences,
  setPreferences,
  convertIncompatible,
  notify,
  manageProfiles,
}: FlowPageProps) {
  const profile = workspace.profiles.find((entry) => entry.id === workspace.activeProfileId)
  const [step, setStep] = useState<Step>(1)
  const [sourceMode, setSourceMode] = useState<'local' | 'online'>('local')
  const [edits, setEdits] = useState<DestinationEdit[]>([])
  const [view, setView] = useState<ResultView>('result')
  const [filter, setFilter] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [writing, setWriting] = useState(false)
  const [completed, setCompleted] = useState<TransferPlan | null>(null)
  const [failure, setFailure] = useState('')
  const [configWrites, setConfigWrites] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [busySourceId, setBusySourceId] = useState('')
  const [sourceStatus, setSourceStatus] = useState<
    { kind: 'success' | 'error' | 'info'; text: string } | null
  >(null)

  const platform = requirePlatform(profile?.platformId)
  const browser = useDirectoryBrowser(profile, true)

  // Switching profile restarts the flow: a plan, a set of staged edits, and a
  // typed confirmation only ever mean something for one destination.
  useEffect(() => {
    setStep(1)
    setEdits([])
    setConfirmation('')
    setCompleted(null)
    setFailure('')
  }, [profile?.id])

  useEffect(() => {
    if (step === 2) setView('current')
    if (step === 4 || step === 5) setView('changes')
  }, [step])

  const operations = useMemo(
    () => (profile ? transferOperations(collection, profile) : []),
    [
      collection,
      profile?.firmwareId,
      profile?.organise,
      profile?.folderLayout,
      profile?.folderTemplate,
      profile?.naming,
    ],
  )
  const incompatible = useMemo(
    () =>
      profile
        ? collection.filter((item) => !isFirmwareCompatible(item, profile.firmwareId))
        : [],
    [collection, profile?.firmwareId],
  )

  /**
   * The one description of this change. The same object is planned on every
   * edit and handed to the executor on confirmation, so the two can never
   * disagree about what was approved.
   */
  const request = useMemo<TransferRequest | null>(() => {
    if (!profile || !isWritable(profile) || incompatible.length > 0) return null
    return {
      target: profile.destination.path,
      operations,
      edits,
      // Removing anything needs a collection to compare the destination with.
      removeExisting: removalPolicy === 'remove' && operations.length > 0,
      managedExtensions: managedFormats(profile),
      verifyChecksums: profile.verifyChecksums ?? false,
    }
  }, [
    profile?.id,
    profile?.destination.path,
    profile?.destination.kind,
    profile?.platformId,
    profile?.firmwareId,
    profile?.verifyChecksums,
    operations,
    edits,
    removalPolicy,
    incompatible.length,
  ])

  const { plan, error: planError, planning } = useTransferPlan(request)

  const summary = useMemo(() => summarisePlan(plan, profile), [plan, profile])
  const { counts, currentCount, resultCount, mismatches, mismatchFormats } = summary

  // Staged titles by where their bytes are, which is how the plan names the
  // ones standing in the way of a write.
  const itemsBySource = useMemo(
    () => new Map(collection.map((item) => [item.path, item])),
    [collection],
  )
  const blocked = useMemo(
    () => blockedTitles(plan, itemsBySource),
    [plan, itemsBySource],
  )

  const itemsByPath = useMemo(
    () =>
      new Map(
        operations.map((operation, index) => [
          operation.relativePath.toLowerCase(),
          collection[index],
        ]),
      ),
    [operations, collection],
  )

  // -------------------------------------------------------------------------
  // Library actions
  // -------------------------------------------------------------------------

  const indexSource = async (source: SourceLocation) => {
    const entries = await scanFolder(source.path, undefined, convertIncompatible)
    const items = entries.map((entry) => classifyMedia(entry, source.path))
    dispatch({ type: 'sourceIndexed', source, items })
    return items.length
  }

  const addLocation = async () => {
    setSourceStatus(null)
    try {
      const path = await chooseFolder('Add software source')
      if (!path) return
      setScanning(true)
      const source: SourceLocation = {
        id: `source:${path}`,
        name: basename(path),
        path,
      }
      const found = await indexSource(source)
      setSourceStatus({
        kind: 'success',
        text: `Added ${source.name} and indexed ${found} recognised file${found === 1 ? '' : 's'} from this folder and its subfolders.`,
      })
    } catch (reason) {
      setSourceStatus({ kind: 'error', text: errorMessage(reason) })
    } finally {
      setScanning(false)
    }
  }

  const refreshLocation = async (source: SourceLocation) => {
    setBusySourceId(source.id)
    setSourceStatus({ kind: 'info', text: `Re-indexing ${source.name}…` })
    try {
      const found = await indexSource(source)
      setSourceStatus({
        kind: 'success',
        text: `Re-indexed ${source.name}: ${found} recognised file${found === 1 ? '' : 's'}.`,
      })
    } catch (reason) {
      setSourceStatus({ kind: 'error', text: errorMessage(reason) })
    } finally {
      setBusySourceId('')
    }
  }

  const importDownload = (
    download: CachedDownload,
    title: OnlineTitle,
    provider: OnlineProvider,
  ) => {
    if (!profile) return
    // Everything cached from one site belongs to that site, not to a source of
    // its own: a folder per download turned the source list into a list of
    // downloads reading "1 title" apiece.
    const site = downloadSourceOf(download.cachePath) ?? download.cachePath
    const items = download.entries.map((entry, index): MediaItem => {
      const classified = classifyMedia(entry, site)
      return {
        ...classified,
        canonicalTitle:
          download.entries.length > 1 ? `${title.title} (Disk ${index + 1})` : title.title,
        assignedPlatformId: title.platformId || classified.assignedPlatformId,
        provenance: {
          providerId: provider.id,
          remoteId: title.remoteId,
          sourceUrl: download.sourceUrl,
          license: download.license || title.license,
        },
      }
    })
    dispatch({
      type: 'itemsImported',
      source: { id: `source:${site}`, name: provider.name, path: site },
      items,
    })
    dispatch({ type: 'collectionAdded', profileId: profile.id, items })
    notify({
      kind: 'success',
      text: `${download.reused ? 'Reused cached' : 'Downloaded'} ${title.title}; added ${items.length} image${items.length === 1 ? '' : 's'} to ${profile.name}.`,
    })
  }

  // -------------------------------------------------------------------------
  // Applying
  // -------------------------------------------------------------------------

  /**
   * Puts the drive's own configuration on the stick alongside the images.
   *
   * A stick of correctly named files still will not behave until the firmware
   * is told how to read it, so this is part of writing rather than something to
   * be discovered later. One already on the drive is left alone: it may have
   * been set up by hand, and replacing it is a decision, not a side effect.
   *
   * A failure here does not fail the transfer, which has already succeeded and
   * been verified. It is reported instead, because a silent one would leave the
   * user with a stick that looks right and does not work.
   */
  const writeDriveConfiguration = async () => {
    if (!profile) return
    const contents = configFor(profile, platform)
    if (!contents) return
    try {
      const state = await firmwareConfigState(profile.destination.path)
      if (state.exists) return
      const written = await writeFirmwareConfig(profile.destination.path, contents)
      setConfigWrites((count) => count + 1)
      notify({ kind: 'info', text: `Wrote ${written} so the drive reads this stick correctly.` })
    } catch (reason) {
      notify({
        kind: 'error',
        text: `The files were written, but the drive configuration was not: ${errorMessage(reason)}`,
      })
    }
  }

  const apply = async () => {
    if (!profile || !request || !plan?.ready || confirmation !== profile.name) return
    setWriting(true)
    setFailure('')
    try {
      const result = await executeTransfer(request)
      setCompleted(result)
      setConfirmation('')
      setEdits([])
      dispatch({ type: 'collectionCleared', profileId: profile.id })
      await writeDriveConfiguration()
      void browser.refresh()
    } catch (reason) {
      setFailure(errorMessage(reason))
      setCompleted(null)
    } finally {
      setWriting(false)
      setStep(6)
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const stageHeading =
    step === 2
      ? { eyebrow: '2 · Current contents', help: 'Browse the destination and stage moves, renames, or deletions.' }
      : step === 4
        ? { eyebrow: '4 · Verify changes', help: 'Compare the current contents, the changes, and the result.' }
        : { eyebrow: '5 · Confirm write', help: 'Resolve any conflict, then confirm with the exact profile name.' }

  return (
    <>
      <nav className="flow-steps" aria-label="GoTek preparation progress">
        {STEP_LABELS.map((label, index) => {
          const number = (index + 1) as Step
          return (
            <button
              key={label}
              className={step === number ? 'active' : step > number ? 'complete' : ''}
              disabled={number > step || (number > 1 && !profile)}
              onClick={() => setStep(number)}
            >
              <span>{step > number ? <Check /> : number}</span>
              <b>{label}</b>
            </button>
          )
        })}
      </nav>

      {step === 1 && (
        <ProfileStep
          profiles={workspace.profiles}
          active={profile}
          select={(id) => dispatch({ type: 'profileSelected', id })}
          manageProfiles={manageProfiles}
          next={() => setStep(2)}
        />
      )}

      {!profile && step > 1 && (
        <div className="notice info">
          Create a profile before choosing files.
          <button className="button secondary" onClick={manageProfiles}>
            Create profile
          </button>
        </div>
      )}

      {profile && (step === 2 || step === 4 || step === 5) && (
        <section className="build-workspace flow-stage">
          <div className="build-workspace-head">
            <div>
              <p className="eyebrow">{stageHeading.eyebrow}</p>
              <h2>{profile.name}</h2>
              <p>
                {plan
                  ? `${currentCount} recognised image${currentCount === 1 ? '' : 's'} found in ${profile.destination.path}`
                  : isWritable(profile)
                    ? stageHeading.help
                    : 'Image contents are available read-only.'}
              </p>
            </div>
            {step === 4 && (
              <fieldset className="write-mode build-write-mode">
                <legend>Files outside this collection</legend>
                <button
                  type="button"
                  className={removalPolicy === 'keep' ? 'active' : ''}
                  aria-pressed={removalPolicy === 'keep'}
                  onClick={() =>
                    dispatch({
                      type: 'removalPolicySet',
                      profileId: profile.id,
                      policy: 'keep',
                    })
                  }
                >
                  Keep
                </button>
                <button
                  type="button"
                  disabled={!collection.length}
                  className={removalPolicy === 'remove' ? 'active' : ''}
                  aria-pressed={removalPolicy === 'remove'}
                  onClick={() =>
                    dispatch({
                      type: 'removalPolicySet',
                      profileId: profile.id,
                      policy: 'remove',
                    })
                  }
                >
                  Remove
                </button>
              </fieldset>
            )}
          </div>

          {step >= 4 && (
            <div className="build-summary" aria-label="Destination result summary">
              <button onClick={() => setView('current')}>
                <span>Current load</span>
                <b>{currentCount}</b>
              </button>
              <button onClick={() => setView('changes')}>
                <span>Additions</span>
                <b>{counts.add}</b>
              </button>
              <button onClick={() => setView('changes')}>
                <span>Removals</span>
                <b>{counts.remove}</b>
              </button>
              <button onClick={() => setView('changes')}>
                <span>Conflicts</span>
                <b>{counts.conflict}</b>
              </button>
              <button onClick={() => setView('result')}>
                <span>Result</span>
                <b>{resultCount}</b>
              </button>
            </div>
          )}

          {mismatches.length > 0 && (
            <div className="profile-mismatch">
              <b>
                {mismatches.length} image{mismatches.length === 1 ? '' : 's'} on this
                destination sit outside the {platform.name} profile
              </b>
              <span>
                {mismatchFormats.join(', ')} files stay visible and are protected from
                removal.
              </span>
              <button type="button" onClick={manageProfiles}>
                Edit profile platform
              </button>
            </div>
          )}

          {step === 2 ? (
            <ContentsStep
              profile={profile}
              browser={browser}
              edits={edits}
              setEdits={setEdits}
              back={() => setStep(1)}
              next={() => setStep(3)}
            />
          ) : (
            <ResultTable
              entries={summary.entries}
              profile={profile}
              view={view}
              setView={setView}
              query={filter}
              setQuery={setFilter}
              itemsByPath={itemsByPath}
              removeFromCollection={(itemIds) =>
                dispatch({ type: 'collectionRemoved', profileId: profile.id, itemIds })
              }
              emptyMessage={
                planning
                  ? 'Checking the destination…'
                  : planError
                    ? planError
                    : !isWritable(profile)
                      ? 'Image destinations are read-only.'
                      : 'No images match this view.'
              }
            />
          )}

          {planning && step !== 2 && (
            <p className="mode-note" role="status" aria-live="polite">
              Checking the destination and available space…
            </p>
          )}
          {planError && step !== 2 && <p className="inline-error">{planError}</p>}
          {incompatible.length > 0 && (
            <p className="inline-error build-review-error">
              {incompatible.length} selected title
              {incompatible.length === 1 ? ' is' : 's are'} incompatible with this
              profile's firmware. Remove them or change the profile's firmware to
              continue.
            </p>
          )}
          {step === 4 && blocked.length > 0 && (
            <div className="blocked-titles">
              <b>
                {blocked.length} staged title{blocked.length === 1 ? '' : 's'} stand
                {blocked.length === 1 ? 's' : ''} in the way of this write
              </b>
              <span>
                {BLOCKER_EXPLANATIONS.filter((entry) =>
                  blocked.some((title) => title.kind === entry.kind),
                ).map((entry) => (
                  <span key={entry.kind}>
                    <b>
                      {blocked.filter((title) => title.kind === entry.kind).length}{' '}
                      {entry.label}
                    </b>{' '}
                    {entry.detail}
                  </span>
                ))}
              </span>
              <ul className="plan-files">
                {blocked.slice(0, 6).map((title) => (
                  <li key={title.item.id}>{title.item.canonicalTitle}</li>
                ))}
                {blocked.length > 6 && <li>…and {blocked.length - 6} more</li>}
              </ul>
              <button
                className="button secondary compact"
                onClick={() =>
                  dispatch({
                    type: 'collectionRemoved',
                    profileId: profile.id,
                    itemIds: blocked.map((title) => title.item.id),
                  })
                }
              >
                <X />
                Take {blocked.length === 1 ? 'it' : `all ${blocked.length}`} out of{' '}
                {profile.name}
              </button>
            </div>
          )}
          {step === 4 &&
            plan?.warnings
              // Anything already listed above is not said twice.
              .filter(
                (warning) => !blocked.some((title) => title.message === warning),
              )
              .map((warning) => (
                <p className="inline-error build-review-error" key={warning}>
                  {warning}
                </p>
              ))}

          {step === 5 && plan && (
            <section className="build-review" aria-label="Write confirmation">
              <div>
                <p className="eyebrow">Apply result</p>
                <h3>
                  {plan.ready
                    ? `${formatBytes(plan.totalBytes)} will be copied and verified`
                    : 'Resolve conflicts before writing'}
                </h3>
                <p>
                  {removalPolicy === 'remove'
                    ? `${plan.removals.length} managed file${plan.removals.length === 1 ? '' : 's'} will be removed.`
                    : 'Existing files will be kept.'}
                </p>
              </div>
              <div className="build-review-confirm">
                <label>
                  Type <b>{profile.name}</b> to confirm
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
                <button
                  className="button"
                  disabled={!plan.ready || confirmation !== profile.name || writing}
                  onClick={() => void apply()}
                >
                  <Upload />
                  {writing ? 'Applying and verifying' : 'Apply to GoTek'}
                </button>
              </div>
              {plan.warnings.map((warning) => (
                <p className="inline-error" key={warning}>
                  {warning}
                </p>
              ))}
              <DriveConfiguration
                profile={profile}
                platform={platform}
                refreshKey={configWrites}
              />
            </section>
          )}

          {step !== 2 && (
            <div className="flow-actions">
              <button
                className="button secondary"
                onClick={() => setStep(step === 4 ? 3 : 4)}
              >
                <ChevronLeft />
                Back
              </button>
              {step === 4 && (
                <button
                  className="button"
                  disabled={!plan?.ready || incompatible.length > 0 || !summary.hasChanges}
                  onClick={() => setStep(5)}
                >
                  Confirm changes
                  <ChevronRight />
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {profile && step === 3 && (
        <section className="sources-stage flow-stage">
          <div className="source-stage-title">
            <div>
              <p className="eyebrow">3 · Sources</p>
              <h2>Choose files to add</h2>
              <p>Use indexed local locations, online catalogues, and cached downloads.</p>
            </div>
          </div>
          <div className="library-mode" role="tablist">
            <button
              role="tab"
              aria-selected={sourceMode === 'local'}
              className={sourceMode === 'local' ? 'active' : ''}
              onClick={() => setSourceMode('local')}
            >
              <FolderOpen />
              On this computer
            </button>
            <button
              role="tab"
              aria-selected={sourceMode === 'online'}
              className={sourceMode === 'online' ? 'active' : ''}
              onClick={() => setSourceMode('online')}
            >
              <Globe2 />
              Find online
            </button>
          </div>

          {sourceMode === 'local' ? (
            <LocalLibrary
              profile={profile}
              platform={platform}
              items={workspace.items}
              sources={workspace.sources}
              collection={collection}
              addLocation={() => void addLocation()}
              refreshLocation={(source) => void refreshLocation(source)}
              renameLocation={(source) => dispatch({ type: 'sourceRenamed', source })}
              removeLocation={(source) => dispatch({ type: 'sourceRemoved', source })}
              assignPlatform={(itemIds, platformId) =>
                dispatch({ type: 'platformAssigned', itemIds, platformId })
              }
              assignCategory={(itemIds, categoryId) =>
                dispatch({ type: 'categoryAssigned', itemIds, categoryId })
              }
              setDisplayTitle={(itemId, displayTitle) =>
                dispatch({ type: 'displayTitleSet', itemId, displayTitle })
              }
              addToCollection={(items) =>
                dispatch({ type: 'collectionAdded', profileId: profile.id, items })
              }
              removeFromCollection={(itemIds) =>
                dispatch({ type: 'collectionRemoved', profileId: profile.id, itemIds })
              }
              preferences={preferences}
              setPreferences={setPreferences}
              status={sourceStatus}
              busySourceId={busySourceId}
            />
          ) : (
            <OnlineLibrary
              platform={platform}
              items={workspace.items}
              providers={providers}
              saveProvider={(provider) =>
                setCustomProviders((current) => upsertById(current, provider))
              }
              removeProvider={(id) =>
                setCustomProviders((current) =>
                  current.filter((provider) => provider.id !== id),
                )
              }
              imported={importDownload}
            />
          )}

          <div className="flow-actions">
            <button className="button secondary" onClick={() => setStep(2)}>
              <ChevronLeft />
              Back
            </button>
            <button
              className="button"
              disabled={!isWritable(profile) || incompatible.length > 0}
              onClick={() => setStep(4)}
            >
              Verify changes
              <ChevronRight />
            </button>
          </div>
        </section>
      )}

      {step === 6 && completed && (
        <section className="flow-summary panel">
          <Check />
          <p className="eyebrow">6 · Summary</p>
          <h2>Write completed</h2>
          <p>Every copied file was flushed to the destination and size-verified.</p>
          <div className="profile-facts">
            <div>
              <span>Destination</span>
              <b>{completed.target}</b>
            </div>
            <div>
              <span>Added</span>
              <b>{completed.result.filter((entry) => entry.status === 'add').length}</b>
            </div>
            <div>
              <span>Moved</span>
              <b>{completed.result.filter((entry) => entry.status === 'move').length}</b>
            </div>
            <div>
              <span>Removed</span>
              <b>{completed.removals.length}</b>
            </div>
            <div>
              <span>Verified bytes</span>
              <b>{formatBytes(completed.totalBytes)}</b>
            </div>
          </div>
          <div className="flow-actions">
            <button className="button" onClick={() => setStep(2)}>
              Review destination
            </button>
            <button className="button secondary" onClick={() => setStep(1)}>
              Choose another profile
            </button>
          </div>
        </section>
      )}

      {step === 6 && failure && (
        <section className="flow-summary failed panel">
          <X />
          <p className="eyebrow">6 · Summary</p>
          <h2>Write failed</h2>
          <p>{failure}</p>
          <p>
            No success has been recorded. Nothing was overwritten. Check the
            destination and review the plan before trying again.
          </p>
          <div className="flow-actions">
            <button className="button" onClick={() => setStep(5)}>
              Return to confirmation
            </button>
            <button className="button secondary" onClick={() => setStep(4)}>
              Review changes
            </button>
          </div>
        </section>
      )}

      {scanning && (
        <ProgressDialog
          title="Finding titles"
          detail="Scanning this folder and its subfolders for supported disk images."
        />
      )}
      {writing && (
        <ProgressDialog
          title="Applying changes"
          detail="Copying to the destination and verifying every write."
        />
      )}
    </>
  )
}
