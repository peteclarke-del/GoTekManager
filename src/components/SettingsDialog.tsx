import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { firmwareProfiles } from '../domain/catalog'
import { formatBytes } from '../domain/media'
import type { AppSettings, CacheSummary, ProfileDefaults } from '../domain/types'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { cacheSummary, clearDownloadCache, evictCache } from '../native/commands'
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
  close,
  clearLibrary,
}: {
  settings: AppSettings
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>
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
