import { useState } from 'react'
import { Check } from 'lucide-react'
import { Options } from './Choices'
import { firmwareProfiles, platforms } from '../domain/catalog'
import { categories, categoryFolderFor, UNCATEGORISED } from '../domain/categories'
import { configSupport, DISPLAY_CHOICES } from '../domain/firmwareConfig'
import {
  FOLDER_TOKENS,
  NAMING_CHOICES,
  namingChoice,
  renderFolderTemplate,
} from '../domain/media'
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
 *
 * The same dialog names a profile that does not exist yet. A destination cannot
 * say which machine it is for, so choosing one asks rather than assuming: the
 * platform is pre-filled from the folder or volume name and the user confirms
 * or corrects it before anything is created.
 */
export function ProfileEditor({
  profile,
  isNew = false,
  waiting = 0,
  save,
  close,
}: {
  profile: Profile
  /** Whether this profile is being created rather than changed. */
  isNew?: boolean
  /** How many further destinations are queued behind this one. */
  waiting?: number
  save: (profile: Profile) => void
  close: () => void
}) {
  const [draft, setDraft] = useState<Profile>(profile)
  const update = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <Modal
      title={isNew ? 'New GoTek profile' : 'Edit GoTek profile'}
      onClose={close}
      className="profile-editor"
    >
      {isNew && (
        <p className="mode-note">
          The platform is a guess from the destination's name. Correct it before
          creating the profile: it decides which titles are offered and where they are
          written.
          {waiting > 0 && ` ${waiting} more destination${waiting === 1 ? '' : 's'} to name after this one.`}
        </p>
      )}
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
          <Options items={platforms} />
        </select>
      </label>
      <label>
        Firmware
        <select
          value={draft.firmwareId}
          onChange={(event) => update('firmwareId', event.target.value)}
        >
          <Options items={firmwareProfiles} />
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
      <label>
        Drive display
        <select
          value={draft.display ?? 'auto'}
          onChange={(event) => update('display', event.target.value as Profile['display'])}
        >
          {DISPLAY_CHOICES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="mode-note">
        {configSupport(draft.firmwareId).writable
          ? draft.display?.endsWith('-rotate')
            ? 'Written to FF.CFG as a rotated panel, which is what puts an upside-down OLED the right way up.'
            : 'Only written to FF.CFG when a panel is named; left on detect, the firmware decides for itself.'
          : 'This firmware has no configuration file, so the setting is recorded but not written.'}
      </p>
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
          <option value="category">Category folders</option>
          <option value="flat">Flat</option>
          <option value="custom">Custom folders</option>
        </select>
      </label>
      {draft.organise && draft.folderLayout === 'category' && (
        <p className="mode-note">
          Titles are written under <code>Games/</code>, <code>Apps/</code>,{' '}
          <code>Demos/</code> and the rest. A title with no category goes to{' '}
          <code>{UNCATEGORISED}/</code>; set them in the library table, several at a
          time. Use a custom layout to combine this with the platform, as in{' '}
          <code>{'{platform}/{category}'}</code>.
        </p>
      )}
      {draft.organise && Object.keys(draft.categoryFolders ?? {}).length > 0 && (
        <div className="category-folders">
          <p className="feed-format">
            This destination's own folder names, adopted from what is already on it. Clear
            one to go back to the name this application would choose.
          </p>
          {categories
            .filter((category) => draft.categoryFolders?.[category.id])
            .map((category) => (
              <label key={category.id}>
                {category.name}
                <input
                  value={draft.categoryFolders?.[category.id] ?? ''}
                  placeholder={categoryFolderFor(undefined, category.id)}
                  onChange={(event) => {
                    const { [category.id]: _replaced, ...rest } = draft.categoryFolders ?? {}
                    const folder = event.target.value.trim()
                    update(
                      'categoryFolders',
                      folder ? { ...rest, [category.id]: folder } : rest,
                    )
                  }}
                />
              </label>
            ))}
        </div>
      )}
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
            Preview: <code>{renderFolderTemplate(draft.folderTemplate ?? '{platform}', SAMPLE, draft) || '(the root)'}/Elite.ssd</code>
          </p>
        </>
      )}
      <label>
        Naming
        <select
          value={draft.naming}
          onChange={(event) => update('naming', event.target.value as Profile['naming'])}
        >
          <Options items={NAMING_CHOICES} />
        </select>
      </label>
      <p className="mode-note">{namingChoice(draft.naming).summary}</p>
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
        {isNew ? 'Create profile' : 'Save profile'}
      </button>
    </Modal>
  )
}
