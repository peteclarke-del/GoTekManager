import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { firmwareProfiles } from '../domain/catalog'
import { formatBytes } from '../domain/media'
import type {
  AppSettings,
  CacheSummary,
  ConversionSupport,
  ProfileDefaults,
} from '../domain/types'
import { useAsyncAction } from '../hooks/useAsyncAction'
import {
  cacheSummary,
  clearDownloadCache,
  evictCache,
  supportedConversions,
} from '../native/commands'
import { Modal } from './Modal'

/** Offered cache ceilings, in bytes. */
const CACHE_LIMITS: Array<[string, number]> = [
  ['500 MB', 500 * 1024 * 1024],
  ['2 GB', 2 * 1024 * 1024 * 1024],
  ['10 GB', 10 * 1024 * 1024 * 1024],
]

function DownloadCache() {
  const [summary, setSummary] = useState<CacheSummary | null>(null)
  const [message, setMessage] = useState('')
  const action = useAsyncAction()

  const refresh = () =>
    action.run(async () => {
      const result = await cacheSummary()
      setSummary(result)
      return result
    })

  useEffect(() => {
    void refresh()
  }, [])

  const trim = (limit: number, label: string) =>
    void action.run(async () => {
      const removed = await evictCache(limit)
      setMessage(
        removed.length
          ? `Removed ${removed.length} cached download${removed.length === 1 ? '' : 's'} to fit ${label}.`
          : `Already within ${label}; nothing was removed.`,
      )
      await refresh()
    })

  return (
    <>
      <h3>Download cache</h3>
      <p className="mode-note">
        Downloads are kept so a title is never fetched twice. Cached catalogues are small
        and are never evicted, so collection coverage keeps working offline.
      </p>
      {summary && (
        <p className="mode-note">
          <b>{formatBytes(summary.totalBytes)}</b> in {summary.downloadCount} download
          {summary.downloadCount === 1 ? '' : 's'}, plus {summary.catalogueCount} cached
          catalogue{summary.catalogueCount === 1 ? '' : 's'}.
        </p>
      )}
      {action.error && <p className="inline-error">{action.error}</p>}
      {message && <p className="mode-note">{message}</p>}
      <div className="target-actions">
        {CACHE_LIMITS.map(([label, limit]) => (
          <button
            key={label}
            className="button secondary compact"
            disabled={action.busy}
            onClick={() => trim(limit, label)}
          >
            Trim to {label}
          </button>
        ))}
        <button
          className="button secondary danger compact"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const removed = await clearDownloadCache()
              setMessage(`Removed ${removed.length} cached download${removed.length === 1 ? '' : 's'}.`)
              await refresh()
            })
          }
        >
          <Trash2 />
          Empty cache
        </button>
      </div>
    </>
  )
}

/**
 * The conversions on offer, named by the native side.
 *
 * Listing them here rather than writing them out again keeps the interface from
 * promising a conversion that was never built, and means adding one to
 * `convert.rs` is enough for it to appear.
 */
function Conversions({
  enabled,
  setEnabled,
}: {
  enabled: boolean
  setEnabled: (value: boolean) => void
}) {
  const [supported, setSupported] = useState<ConversionSupport[]>([])

  useEffect(() => {
    supportedConversions().then(setSupported, () => setSupported([]))
  }, [])

  return (
    <>
      <h3>Converting images</h3>
      <p className="mode-note">
        Some software is only distributed in formats a GoTek cannot present. When this is
        on, indexing writes a converted copy into the cache and lists that instead. The
        file it was made from is never changed, and anything that cannot be converted
        cleanly is left out rather than guessed at.
      </p>
      <label className="check-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Convert incompatible images while indexing
      </label>
      {supported.length > 0 && (
        <ul className="mode-note plain-list">
          {supported.map((entry) => (
            <li key={entry.conversion}>
              <b>
                {entry.from} to {entry.to}
              </b>{' '}
              — {entry.summary}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * Application settings.
 *
 * The layout and naming rules here are the starting point for a *new* profile.
 * They used to be stored as global settings but only ever read as defaults,
 * which made it look as though changing them would alter existing profiles.
 * Saying so plainly is the whole fix.
 */
export function SettingsDialog({
  settings,
  setSettings,
  providersPath,
  close,
  clearLibrary,
}: {
  settings: AppSettings
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>
  /** Where a hand-written source list is read from. */
  providersPath: string
  close: () => void
  clearLibrary: () => void
}) {
  const setDefault = <K extends keyof ProfileDefaults>(key: K, value: ProfileDefaults[K]) =>
    setSettings((current) => ({
      ...current,
      defaults: { ...current.defaults, [key]: value },
    }))

  return (
    <Modal title="Settings" onClose={close}>
      <label>
        Theme
        <select
          value={settings.theme}
          onChange={(event) =>
            setSettings((current) => ({
              ...current,
              theme: event.target.value as AppSettings['theme'],
            }))
          }
        >
          <option value="system">Match the system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>

      <h3>Defaults for new profiles</h3>
      <p className="mode-note">
        Existing profiles keep their own settings. Edit a profile to change it.
      </p>
      <label>
        Firmware
        <select
          value={settings.defaults.firmwareId}
          onChange={(event) => setDefault('firmwareId', event.target.value)}
        >
          {firmwareProfiles.map((firmware) => (
            <option key={firmware.id} value={firmware.id}>
              {firmware.name}
            </option>
          ))}
        </select>
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={settings.defaults.organise}
          onChange={(event) => setDefault('organise', event.target.checked)}
        />
        Organise output into folders
      </label>
      <label>
        Layout
        <select
          disabled={!settings.defaults.organise}
          value={settings.defaults.folderLayout}
          onChange={(event) =>
            setDefault('folderLayout', event.target.value as ProfileDefaults['folderLayout'])
          }
        >
          <option value="platform">Platform folders</option>
          <option value="flat">Flat</option>
          <option value="custom">Custom folders</option>
        </select>
      </label>
      <label>
        Naming
        <select
          value={settings.defaults.naming}
          onChange={(event) =>
            setDefault('naming', event.target.value as ProfileDefaults['naming'])
          }
        >
          <option value="oled">OLED friendly</option>
          <option value="original">Original</option>
        </select>
      </label>

      <Conversions
        enabled={settings.convertIncompatible}
        setEnabled={(convertIncompatible) =>
          setSettings((current) => ({ ...current, convertIncompatible }))
        }
      />

      <h3>Online sources</h3>
      <p className="mode-note">
        The list of sites is a JSON file. Put one at the path below to replace the
        built-in list; it is read when the application starts, and anything unusable in
        it is reported rather than ignored.
      </p>
      <label>
        Source list
        <input readOnly value={providersPath || 'Available in the desktop application'} />
      </label>

      <DownloadCache />

      <h3>Library</h3>
      <p className="mode-note">
        Removes the indexed titles and source locations. No file on disk is touched
        and no profile is removed.
      </p>
      <button className="button secondary danger" onClick={clearLibrary}>
        <Trash2 />
        Clear local index
      </button>
    </Modal>
  )
}
