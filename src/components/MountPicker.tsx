import { Check } from 'lucide-react'
import { formatBytes } from '../domain/media'
import type { MountedTarget } from '../domain/types'
import { Modal } from './Modal'

const KIND_LABELS: Record<MountedTarget['kind'], string> = {
  removable: 'Removable',
  network: 'Network',
  fixed: 'Fixed disk',
  system: 'System',
}

/**
 * Explicit selection of discovered mounts.
 *
 * Discovery never adds anything to the workspace on its own: the user chooses
 * which mounts become profiles, and system volumes are hidden unless asked for.
 */
export function MountPicker({
  mounts,
  selected,
  setSelected,
  showSystem,
  setShowSystem,
  refresh,
  close,
  apply,
  busy,
  error,
}: {
  mounts: MountedTarget[]
  selected: string[]
  setSelected: React.Dispatch<React.SetStateAction<string[]>>
  showSystem: boolean
  setShowSystem: (value: boolean) => void
  refresh: (includeSystem: boolean) => void
  close: () => void
  apply: () => void
  busy: boolean
  error: string
}) {
  const toggle = (path: string) =>
    setSelected((current) =>
      current.includes(path)
        ? current.filter((entry) => entry !== path)
        : [...current, path],
    )

  return (
    <Modal title="Select mounted storage" onClose={close} className="mount-picker">
      <p>
        Only the mounts you select become profiles. Removable volumes and network
        shares are shown by default.
      </p>
      <label className="mount-filter">
        <input
          type="checkbox"
          checked={showSystem}
          onChange={(event) => {
            setShowSystem(event.target.checked)
            refresh(event.target.checked)
          }}
        />
        Show system, container, and other virtual mounts
      </label>
      {error && <p className="inline-error">{error}</p>}
      <div className="mount-list">
        {mounts.map((mount) => (
          <label className="mount-option" key={mount.path}>
            <input
              type="checkbox"
              checked={selected.includes(mount.path)}
              onChange={() => toggle(mount.path)}
            />
            <span>
              <b>{mount.label}</b>
              <small title={mount.path}>{mount.path}</small>
            </span>
            <small>
              {KIND_LABELS[mount.kind]} · {mount.filesystem}
              {mount.availableBytes !== undefined && mount.totalBytes !== undefined
                ? ` · ${formatBytes(mount.availableBytes)} free of ${formatBytes(mount.totalBytes)}`
                : ''}
            </small>
          </label>
        ))}
        {!mounts.length && !busy && <p>No readable mounts were found.</p>}
        {busy && <p>Looking for mounted storage…</p>}
      </div>
      <button className="button" onClick={apply} disabled={!selected.length}>
        <Check />
        Add {selected.length || 'selected'} profile{selected.length === 1 ? '' : 's'}
      </button>
    </Modal>
  )
}
