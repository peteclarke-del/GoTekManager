import { useState } from 'react'
import { Check } from 'lucide-react'
import { firmwareProfiles, platforms } from '../domain/catalog'
import { FOLDER_TOKENS, renderFolderTemplate } from '../domain/media'
import type { MediaItem, Profile } from '../domain/types'
import { Modal } from './Modal'

/** A stand-in title, so the folder template can be previewed as it is typed. */
const SAMPLE: MediaItem = {
  id: 'sample',
  source: '',
  name: 'Elite (1984).ssd',
  path: 'Elite (1984).ssd',
  extension: 'ssd',
  size: 204800,
  directory: false,
  likelyPlatformIds: [],
  assignedPlatformId: 'bbc',
  canonicalTitle: 'Elite (1984).ssd',
}

const DESTINATION_LABELS: Record<Profile['destination']['kind'], string> = {
  folder: 'Folder',
  volume: 'Mounted volume',
  image: 'FAT image (read-only)',
}

/**
 * Edits everything a profile owns in one dialog.
 *
 * Changes are held locally and applied on save, so abandoning the dialog cannot
 * leave a profile half-edited.
 */
export function ProfileEditor({
  profile,
  save,
  close,
}: {
  profile: Profile
  save: (profile: Profile) => void
  close: () => void
}) {
  const [draft, setDraft] = useState<Profile>(profile)
  const update = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <Modal title="Edit GoTek profile" onClose={close} className="profile-editor">
      <label>
        Name
        <input value={draft.name} onChange={(event) => update('name', event.target.value)} />
      </label>
      <label>
        Destination
        <input readOnly value={draft.destination.path} />
      </label>
      <p className="mode-note">{DESTINATION_LABELS[draft.destination.kind]}</p>
      <label>
        Platform
        <select
          value={draft.platformId}
          onChange={(event) => update('platformId', event.target.value)}
        >
          {platforms.map((platform) => (
            <option key={platform.id} value={platform.id}>
              {platform.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Firmware
        <select
          value={draft.firmwareId}
          onChange={(event) => update('firmwareId', event.target.value)}
        >
          {firmwareProfiles.map((firmware) => (
            <option key={firmware.id} value={firmware.id}>
              {firmware.name}
            </option>
          ))}
        </select>
      </label>
      {draft.destination.detectedFirmwareId &&
        draft.destination.detectedFirmwareId !== draft.firmwareId && (
          <p className="mode-note">
            Configuration files on this destination suggest{' '}
            <b>
              {firmwareProfiles.find(
                (firmware) => firmware.id === draft.destination.detectedFirmwareId,
              )?.name}
            </b>
            .
          </p>
        )}
      <label className="check-label">
        <input
          type="checkbox"
          checked={draft.organise}
          onChange={(event) => update('organise', event.target.checked)}
        />
        Organise output into folders
      </label>
      <label>
        Layout
        <select
          disabled={!draft.organise}
          value={draft.folderLayout}
          onChange={(event) =>
            update('folderLayout', event.target.value as Profile['folderLayout'])
          }
        >
          <option value="platform">Platform folders</option>
          <option value="flat">Flat</option>
          <option value="custom">Custom folders</option>
        </select>
      </label>
      {draft.organise && draft.folderLayout === 'custom' && (
        <>
          <label>
            Folder template
            <input
              value={draft.folderTemplate ?? '{platform}'}
              placeholder="{platform}/{initial}"
              onChange={(event) => update('folderTemplate', event.target.value)}
            />
          </label>
          <p className="feed-format">
            Available: {FOLDER_TOKENS.map((token) => `{${token}}`).join(', ')}. Use{' '}
            <code>/</code> to nest. <b>{'{initial}'}</b> groups alphabetically, which is what
            makes a few thousand titles navigable on a two-line display.
          </p>
          <p className="mode-note">
            Preview: <code>{renderFolderTemplate(draft.folderTemplate ?? '{platform}', SAMPLE) || '(the root)'}/Elite.ssd</code>
          </p>
        </>
      )}
      <label>
        Naming
        <select
          value={draft.naming}
          onChange={(event) => update('naming', event.target.value as Profile['naming'])}
        >
          <option value="oled">OLED friendly</option>
          <option value="original">Original</option>
        </select>
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={draft.verifyChecksums ?? false}
          onChange={(event) => update('verifyChecksums', event.target.checked)}
        />
        Verify every copied file with a checksum
      </label>
      <p className="mode-note">
        Slower, but it is the only way to catch media that accepts the bytes and stores
        something else, which is how a failing USB stick behaves.
      </p>
      <button
        className="button"
        disabled={!draft.name.trim()}
        onClick={() => save({ ...draft, name: draft.name.trim() })}
      >
        <Check />
        Save profile
      </button>
    </Modal>
  )
}
