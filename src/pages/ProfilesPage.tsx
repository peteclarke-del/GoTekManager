import { useEffect, useState } from 'react'
import {
  Archive,
  Check,
  ChevronLeft,
  FolderOpen,
  HardDrive,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Empty } from '../components/Feedback'
import { FileBrowserTable } from '../components/FileBrowserTable'
import { ProfileEditor } from '../components/ProfileEditor'
import { requireFirmware, requirePlatform } from '../domain/catalog'
import { formatBytes, transferOperations } from '../domain/media'
import { basename } from '../domain/paths'
import type {
  MediaItem,
  Notice,
  Profile,
  ProfileDefaults,
  TargetSummary,
} from '../domain/types'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useDirectoryBrowser } from '../hooks/useDirectoryBrowser'
import { useProfileDrafts } from '../hooks/useProfileDrafts'
import {
  chooseFolder,
  chooseImageFile,
  chooseSaveImagePath,
  createImage,
  errorMessage,
  extractImage,
  inspectTarget,
} from '../native/commands'

/** Room for the files plus FAT's own structures, rounded up to a whole MB. */
function imageSizeFor(totalBytes: number): number {
  const withSlack = totalBytes * 1.15 + 16 * 1024 * 1024
  const megabytes = Math.ceil(Math.max(withSlack, 32 * 1024 * 1024) / (1024 * 1024))
  return megabytes * 1024 * 1024
}
import { createProfile, profileIdFor, type WorkspaceAction } from '../state/workspace'

const STATE_LABELS: Record<TargetSummary['kind'], string> = {
  folder: 'Ready',
  image: 'Read only',
  missing: 'Not found',
}

/**
 * Creating, editing, and inspecting profiles.
 *
 * Every profile's destination is re-checked when it is selected, so a volume
 * that has been unplugged or has become read-only is reported here rather than
 * discovered halfway through a write.
 */
export function ProfilesPage({
  profiles,
  active,
  collection,
  defaults,
  dispatch,
  discoverMounts,
  notify,
}: {
  profiles: Profile[]
  active?: Profile
  collection: MediaItem[]
  defaults: ProfileDefaults
  dispatch: React.Dispatch<WorkspaceAction>
  discoverMounts: () => void
  notify: (notice: Notice) => void
}) {
  const [editing, setEditing] = useState<Profile | null>(null)
  const [summary, setSummary] = useState<TargetSummary | null>(null)
  const drafts = useProfileDrafts((profile) => {
    dispatch({ type: 'profileAdded', profile })
    notify({ kind: 'success', text: `Created the profile ${profile.name}.` })
  })
  const browser = useDirectoryBrowser(active, false)
  const imaging = useAsyncAction()

  /** Builds a new image holding whatever this profile has staged. */
  const buildImage = () =>
    active &&
    void imaging.run(async () => {
      const path = await chooseSaveImagePath()
      if (!path) return
      const operations = transferOperations(collection, active)
      const written = await createImage(
        path,
        {
          sizeBytes: imageSizeFor(operations.reduce((total, item) => total + item.size, 0)),
          label: active.name,
          fat: 'auto',
          partitioned: true,
        },
        operations,
      )
      notify({
        kind: 'success',
        text: `Created ${basename(path)} with ${operations.length} title${operations.length === 1 ? '' : 's'} (${formatBytes(written)}).`,
      })
    })

  /** Unpacks the active image profile into a folder, never overwriting. */
  const unpackImage = () =>
    active &&
    void imaging.run(async () => {
      const folder = await chooseFolder('Unpack the image into')
      if (!folder) return
      const files = await extractImage(active.destination.path, folder)
      notify({
        kind: 'success',
        text: `Unpacked ${files.length} file${files.length === 1 ? '' : 's'} into ${basename(folder)}.`,
      })
    })

  useEffect(() => {
    let cancelled = false
    setSummary(null)
    if (!active) return
    inspectTarget(active.destination.path)
      .then((result) => {
        if (cancelled) return
        setSummary(result)
        dispatch({ type: 'profileDestinationChecked', id: active.id, summary: result })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [active?.id, active?.destination.path, dispatch])

  /**
   * Turns a chosen destination into a draft profile.
   *
   * The platform can only be guessed from the folder's name, and a wrong guess
   * decides which titles are offered and where they are written, so the draft
   * is shown in the editor and becomes a profile only once it is accepted.
   */
  const addProfile = async (pick: () => Promise<string | null>, kind: 'folder' | 'image') => {
    try {
      const path = await pick()
      if (!path) return
      const detected = kind === 'folder' ? await inspectTarget(path) : null
      const profile = createProfile(
        {
          kind,
          path,
          detectedFirmwareId: detected?.detectedFirmwareId,
          totalBytes: detected?.totalBytes,
          availableBytes: detected?.availableBytes,
        },
        defaults,
      )
      if (profiles.some((existing) => existing.id === profile.id)) {
        dispatch({ type: 'profileSelected', id: profile.id })
        notify({ kind: 'info', text: `${profile.name} is already a profile.` })
        return
      }
      drafts.propose([profile])
    } catch (reason) {
      notify({ kind: 'error', text: errorMessage(reason) })
    }
  }

  /**
   * Repoints a folder profile at whichever folder is being browsed. The id is
   * derived from the destination, so this creates a profile for the new folder
   * and leaves the original one alone.
   */
  const useBrowsedFolder = () => {
    if (!active || browser.isImage || browser.path === active.destination.path) return
    const destination: Profile['destination'] = {
      ...active.destination,
      kind: 'folder',
      path: browser.path,
    }
    const profile: Profile = {
      ...active,
      id: profileIdFor(destination),
      name: basename(browser.path),
      destination,
    }
    dispatch({ type: 'profileAdded', profile })
    notify({
      kind: 'success',
      text: `Created the profile ${profile.name} for ${browser.path}.`,
    })
  }

  return (
    <div className="targets-layout">
      <section className="panel target-manager">
        <div className="panel-title">
          <div>
            <h2>GoTek profiles</h2>
            <p>Each profile keeps its platform, firmware, layout, and destination together</p>
          </div>
        </div>
        <div className="target-actions">
          <button className="button" onClick={() => void addProfile(() => chooseFolder('Choose a folder or mounted GoTek volume'), 'folder')}>
            <FolderOpen />
            Choose folder
          </button>
          <button className="button secondary" onClick={() => void addProfile(chooseImageFile, 'image')}>
            <Archive />
            Open image
          </button>
          <button className="button secondary" onClick={discoverMounts}>
            <RefreshCw />
            Add mounted volume
          </button>
        </div>
        {active && (
          <div className="target-actions">
            <button
              className="button secondary compact"
              disabled={imaging.busy || !collection.length}
              title={
                collection.length
                  ? 'Build a FAT image holding this profile’s staged titles'
                  : 'Stage some titles first'
              }
              onClick={buildImage}
            >
              <Archive />
              Create image
            </button>
            {active.destination.kind === 'image' && (
              <button
                className="button secondary compact"
                disabled={imaging.busy}
                onClick={unpackImage}
              >
                <FolderOpen />
                Unpack image
              </button>
            )}
          </div>
        )}
        {imaging.error && <p className="inline-error">{imaging.error}</p>}
        <p className="target-picker-help">
          “Choose folder” opens the system folder picker, where you can navigate to any
          mounted drive or local directory before making it a profile's destination.
        </p>
        <div
          className="managed-targets setup-scroll-list"
          tabIndex={0}
          aria-label="GoTek profiles"
        >
          {profiles.map((profile) => {
            const selected = profile.id === active?.id
            return (
              <button
                key={profile.id}
                className={selected ? 'selected' : ''}
                aria-pressed={selected}
                onClick={() => dispatch({ type: 'profileSelected', id: profile.id })}
              >
                <HardDrive />
                <span>
                  <b>{profile.name}</b>
                  <small>
                    {requirePlatform(profile.platformId).name} ·{' '}
                    {requireFirmware(profile.firmwareId).name}
                  </small>
                </span>
                {selected && <Check className="selection-check" />}
              </button>
            )
          })}
        </div>
        {!profiles.length && (
          <Empty
            title="No GoTek profiles yet"
            action="New folder profile"
            run={() => void addProfile(() => chooseFolder('Choose a folder'), 'folder')}
          />
        )}
      </section>

      {active ? (
        <section className="panel target-view">
          <div className="panel-title">
            <div>
              <p className="eyebrow">
                {active.destination.kind === 'image'
                  ? 'FAT image'
                  : active.destination.kind === 'volume'
                    ? 'Mounted volume'
                    : 'Folder'}{' '}
                · {summary ? STATE_LABELS[summary.kind] : 'Checking'}
                {summary?.exists && !summary.writable && summary.kind === 'folder'
                  ? ' · read-only'
                  : ''}
              </p>
              <h2>{active.name}</h2>
              <p className="path">
                {browser.isImage
                  ? `${active.destination.path} :: /${browser.path}`
                  : browser.path}
              </p>
              {summary?.availableBytes !== undefined && summary.totalBytes !== undefined && (
                <p className="path">
                  {formatBytes(summary.availableBytes)} free of{' '}
                  {formatBytes(summary.totalBytes)}
                </p>
              )}
            </div>
            <div className="inline-actions">
              <button className="icon-button" title="Edit profile" onClick={() => setEditing(active)}>
                <Pencil />
              </button>
              <button
                className="icon-button"
                title="Remove profile"
                onClick={() => dispatch({ type: 'profileRemoved', id: active.id })}
              >
                <Trash2 />
              </button>
              <button
                className="icon-button"
                title="Refresh contents"
                onClick={() => void browser.refresh()}
              >
                <RefreshCw className={browser.busy ? 'spinning' : ''} />
              </button>
            </div>
          </div>

          {summary && !summary.exists && (
            <div className="notice error">
              This destination is not currently available. Reconnect the device or edit
              the profile.
            </div>
          )}

          {browser.canGoUp && (
            <button className="button secondary back" onClick={() => void browser.goUp()}>
              <ChevronLeft />
              Parent
            </button>
          )}
          {browser.error && <p className="inline-error">{browser.error}</p>}

          {!browser.isImage && browser.path !== active.destination.path && (
            <div className="target-folder-choice">
              <span>
                Browsing <b>{browser.path}</b>
              </span>
              <button className="button" onClick={useBrowsedFolder}>
                <Check />
                Create a profile for this folder
              </button>
            </div>
          )}

          <div className="table-wrap">
            <FileBrowserTable
              entries={browser.entries}
              isImage={browser.isImage}
              onOpen={(entry) => void browser.open(entry.path)}
            />
          </div>
          <p className="target-browser-help">
            Double-click a folder, or focus it and press Enter, to browse into it. Use
            “Parent” to go back.
          </p>
        </section>
      ) : (
        <section className="panel">
          <Empty
            title="Select or add a GoTek profile"
            action="New folder profile"
            run={() => void addProfile(() => chooseFolder('Choose a folder'), 'folder')}
          />
        </section>
      )}

      {editing && (
        <ProfileEditor
          profile={editing}
          close={() => setEditing(null)}
          save={(profile) => {
            dispatch({ type: 'profileUpdated', profile })
            setEditing(null)
          }}
        />
      )}

      {drafts.current && (
        <ProfileEditor
          isNew
          waiting={drafts.waiting}
          profile={drafts.current}
          close={drafts.discard}
          save={drafts.accept}
        />
      )}
    </div>
  )
}
