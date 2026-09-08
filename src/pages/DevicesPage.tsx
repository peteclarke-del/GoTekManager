/**
 * Physical devices and provisioning.
 *
 * This is the only screen in the application that can destroy data the user did
 * not choose to delete, so it is built to slow the user down rather than to
 * flow: a device is picked, a plan spells out exactly what will be lost, and a
 * phrase naming that specific device has to be typed before anything happens.
 *
 * The backend re-checks every one of those things independently. Nothing here
 * is the only thing standing between a mistake and a wiped disk.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  Check,
  HardDrive,
  ListChecks,
  RefreshCw,
  Disc,
  ShieldAlert,
  Upload,
  Usb,
  Wand2,
  X,
} from 'lucide-react'
import { Empty, InlineStatus, ProgressDialog } from '../components/Feedback'
import { formatBytes, managedFormats } from '../domain/media'
import {
  costOf,
  proposeExclusions,
  type Capacity,
  type HeldFile,
} from '../domain/deviceBuild'
import { ContentsPicker } from './ContentsPicker'
import type {
  ImageOptions,
  Notice,
  PhysicalDevice,
  Profile,
  ProvisionPlan,
  ProvisionReport,
} from '../domain/types'
import { useAsyncAction } from '../hooks/useAsyncAction'
import {
  chooseImageFile,
  deviceIdentity,
  executeProvision,
  imageCapacity,
  physicalDevices,
  planProvision,
  readDestination,
  type ProvisionRequest,
  type ProvisionSource,
} from '../native/commands'

/**
 * What kind of thing a device is, in the words somebody looking for their stick
 * would use.
 *
 * The operating system reports a transport and a removable flag; neither on its
 * own says "this is the USB stick I just plugged in", which is the only
 * question being asked of this list.
 */
export type DeviceKind = 'usb' | 'removable' | 'fixed' | 'system'

export function kindOf(device: PhysicalDevice): DeviceKind {
  if (device.system) return 'system'
  if ((device.transport ?? '').toLowerCase().includes('usb')) return 'usb'
  return device.removable ? 'removable' : 'fixed'
}

const KIND_ICONS: Record<DeviceKind, typeof HardDrive> = {
  usb: Usb,
  removable: Disc,
  fixed: HardDrive,
  system: ShieldAlert,
}

const KIND_LABELS: Record<DeviceKind, string> = {
  usb: 'USB',
  removable: 'Removable',
  fixed: 'Fixed disk',
  system: 'System disk',
}

/** The filters offered above the list, in the order they are useful. */
const KIND_FILTERS: Array<[string, string]> = [
  ['all', 'All'],
  ['usb', 'USB'],
  ['removable', 'Removable'],
  ['fixed', 'Fixed'],
]

/** Leaves room for the partition table and a little slack at the end. */
function imageSizeFor(device: PhysicalDevice): number {
  return Math.max(2 * 1024 * 1024, device.sizeBytes - 4 * 1024 * 1024)
}

function DeviceRow({
  device,
  selected,
  onSelect,
}: {
  device: PhysicalDevice
  selected: boolean
  onSelect: () => void
}) {
  const usable = !device.system
  const kind = kindOf(device)
  const Icon = KIND_ICONS[kind]
  return (
    <button
      className={`device-row ${selected ? 'selected' : ''} ${usable ? '' : 'blocked'}`}
      aria-pressed={selected}
      disabled={!usable}
      onClick={onSelect}
      title={
        usable
          ? undefined
          : 'This device carries the running operating system and can never be written to.'
      }
    >
      <Icon />
      <span>
        <b>{device.name}</b>
        <small>
          {KIND_LABELS[kind]} · {device.node} · {formatBytes(device.sizeBytes)}
          {device.transport ? ` · ${device.transport}` : ''}
          {device.serial ? ` · serial ${device.serial}` : ' · no serial reported'}
        </small>
        <small className="device-partitions">
          {device.partitions.length
            ? device.partitions
                .map(
                  (partition) =>
                    `${partition.node} ${partition.filesystem || 'unknown'}${
                      partition.label ? ` “${partition.label}”` : ''
                    }`,
                )
                .join(' · ')
            : 'No partitions'}
        </small>
        {device.system && <small className="device-system">System device — protected</small>}
      </span>
      {selected && <Check />}
    </button>
  )
}

export function DevicesPage({
  profiles,
  activeProfileId,
  notify,
}: {
  /** Every profile: a stick is written from whichever one is chosen here. */
  profiles: Profile[]
  activeProfileId: string
  notify: (notice: Notice) => void
}) {
  const [devices, setDevices] = useState<PhysicalDevice[]>([])
  const [selectedNode, setSelectedNode] = useState('')
  /** Which kinds of device the list shows. A stick is what people come for. */
  const [kindFilter, setKindFilter] = useState('all')
  const [sourceKind, setSourceKind] = useState<'build' | 'image'>('build')
  const [imagePath, setImagePath] = useState('')
  const [profileId, setProfileId] = useState(activeProfileId)
  /** What the chosen profile's destination holds, read when it is chosen. */
  const [held, setHeld] = useState<HeldFile[] | null>(null)
  const [capacity, setCapacity] = useState<Capacity | null>(null)
  /** The files this write will carry, once anything has been left out. */
  const [chosen, setChosen] = useState<HeldFile[] | null>(null)
  const [picking, setPicking] = useState<{ excluded: Set<string>; steps: string[] } | null>(
    null,
  )
  const reading = useAsyncAction()
  const [plan, setPlan] = useState<ProvisionPlan | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [report, setReport] = useState<ProvisionReport | null>(null)
  const scan = useAsyncAction()
  const planning = useAsyncAction()
  const writing = useAsyncAction()

  const selected = devices.find((device) => device.node === selectedNode)
  // A system disk is always listed, whatever the filter: leaving it out would
  // suggest it might be missing rather than refused.
  const shown = devices.filter(
    (device) =>
      kindFilter === 'all' || kindOf(device) === kindFilter || kindOf(device) === 'system',
  )

  const refresh = () =>
    scan.run(async () => {
      const found = await physicalDevices()
      setDevices(found)
      // A plan is only ever about one device as it was; re-scanning invalidates it.
      setPlan(null)
      setConfirmation('')
      return found
    })

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    setPlan(null)
    setConfirmation('')
    setReport(null)
  }, [selectedNode, sourceKind, imagePath])

  const profile = profiles.find((entry) => entry.id === profileId) ?? profiles[0]

  // What goes on the stick: the profile's destination as it stands, minus
  // anything left out for this write. The folder is the master and the stick is
  // a copy of it, so nothing is re-laid-out on the way.
  const writing_files = chosen ?? held ?? []
  const operations = useMemo(
    () =>
      writing_files.map((file) => ({
        source: file.source,
        relativePath: file.relativePath,
        size: file.size,
      })),
    [writing_files],
  )

  const needed = capacity ? costOf(writing_files, capacity.clusterBytes) : 0
  const fits = !capacity || needed <= capacity.usableBytes

  // Reading a destination and measuring the stick are both about one pairing of
  // profile and device, so they are asked for together and forgotten together.
  useEffect(() => {
    setHeld(null)
    setChosen(null)
    setCapacity(null)
    if (!profile || !selected || sourceKind !== 'build') return
    void reading.run(async () => {
      const [files, measured] = await Promise.all([
        readDestination(profile.destination.path),
        imageCapacity({
          sizeBytes: imageSizeFor(selected),
          label: profile.name,
          fat: 'auto',
          partitioned: true,
        }),
      ])
      setHeld(files)
      setCapacity(measured)
      return files
    })
  }, [profile?.id, profile?.destination.path, selectedNode, sourceKind])

  const source = (): ProvisionSource | null => {
    if (sourceKind === 'image') {
      return imagePath ? { kind: 'image', path: imagePath } : null
    }
    if (!selected || !profile || !operations.length || !fits) return null
    const options: ImageOptions = {
      sizeBytes: imageSizeFor(selected),
      label: profile.name,
      fat: 'auto',
      partitioned: true,
    }
    return { kind: 'build', options, operations }
  }

  const request = (): ProvisionRequest | null => {
    const chosen = source()
    if (!selected || !chosen) return null
    return { deviceIdentity: deviceIdentity(selected), source: chosen }
  }

  const buildPlan = () => {
    const next = request()
    if (!next) return
    void planning.run(async () => {
      const result = await planProvision(next)
      setPlan(result)
      setConfirmation('')
      return result
    })
  }

  const write = () => {
    const next = request()
    if (!next || !plan) return
    void writing.run(async () => {
      const result = await executeProvision(next, confirmation)
      setReport(result)
      setPlan(null)
      setConfirmation('')
      notify({
        kind: 'success',
        text: `Wrote and verified ${formatBytes(result.bytesWritten)} to ${result.device}.`,
      })
      await refresh()
      return result
    })
  }

  const canPlan =
    Boolean(selected) &&
    (sourceKind === 'image'
      ? Boolean(imagePath)
      : Boolean(profile) && operations.length > 0 && fits)

  return (
    <div className="targets-layout">
      <section className="panel target-manager">
        <div className="panel-title">
          <div>
            <h2>Storage devices</h2>
            <p>Every disk the system reports, whether or not it can be written to</p>
          </div>
        </div>
        <div className="target-actions">
          <button className="button secondary" disabled={scan.busy} onClick={() => void refresh()}>
            <RefreshCw className={scan.busy ? 'spinning' : ''} />
            {scan.busy ? 'Scanning' : 'Rescan devices'}
          </button>
        </div>
        <div className="coverage-filter" role="group" aria-label="Show devices by kind">
          {KIND_FILTERS.map(([value, label]) => {
            const count =
              value === 'all'
                ? devices.length
                : devices.filter((device) => kindOf(device) === value).length
            return (
              <button
                key={value}
                className={kindFilter === value ? 'active' : ''}
                aria-pressed={kindFilter === value}
                disabled={value !== 'all' && !count}
                onClick={() => setKindFilter(value)}
              >
                {label} <small>{count}</small>
              </button>
            )
          })}
        </div>
        {scan.error && <p className="inline-error">{scan.error}</p>}
        <div className="managed-targets setup-scroll-list" aria-label="Storage devices">
          {shown.map((device) => (
            <DeviceRow
              key={device.node}
              device={device}
              selected={device.node === selectedNode}
              onSelect={() => setSelectedNode(device.node)}
            />
          ))}
        </div>
        {!devices.length && !scan.busy && (
          <Empty title="No devices reported" action="Rescan devices" run={() => void refresh()} />
        )}
        <div className="provider-note">
          <b>Identity, not location</b>
          <p>
            A device is addressed by its node, model, serial, and size, never by where it
            happens to be mounted. If you unplug it and plug in another, the plan stops
            matching and is refused.
          </p>
        </div>
      </section>

      <section className="panel target-view">
        {!selected ? (
          <Empty title="Select a device to provision" />
        ) : (
          <>
            <div className="panel-title">
              <div>
                <p className="eyebrow">
                  {selected.removable ? 'Removable' : 'Fixed'} · {selected.transport || 'unknown bus'}
                </p>
                <h2>{selected.name}</h2>
                <p className="path">
                  {selected.node} · {formatBytes(selected.sizeBytes)}
                </p>
              </div>
            </div>

            <fieldset className="write-mode">
              <legend>What to write</legend>
              {/* The choice of profile *is* the choice of what to write, so it
                  is one control rather than a mode button and a second list
                  underneath repeating the same decision. */}
              <select
                className={sourceKind === 'build' ? 'active' : ''}
                aria-label="Profile to copy to this device"
                disabled={!profiles.length}
                value={sourceKind === 'build' ? (profile?.id ?? '') : ''}
                onChange={(event) => {
                  setProfileId(event.target.value)
                  setSourceKind('build')
                }}
              >
                {!profiles.length && <option value="">No profiles yet</option>}
                {profiles.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={sourceKind === 'image' ? 'active' : ''}
                aria-pressed={sourceKind === 'image'}
                onClick={() => setSourceKind('image')}
              >
                Write an existing image
              </button>
            </fieldset>

            {sourceKind === 'build' ? (
              <>
                {!profiles.length && (
                  <p className="mode-note">
                    Create a profile first: a stick is a copy of a profile's destination.
                  </p>
                )}
                {reading.busy && (
                  <InlineStatus kind="info">
                    Reading {profile?.name} and measuring the stick. A destination held on a
                    network share takes a moment.
                  </InlineStatus>
                )}
                {reading.error && <p className="inline-error">{reading.error}</p>}
                {held && capacity && (
                  <>
                    <p className="mode-note">
                      A fresh FAT volume labelled “{profile?.name}” holding a copy of{' '}
                      <code>{profile?.destination.path}</code>, exactly as it is laid out
                      there. {managedFormats(profile!).join(', ')}.
                    </p>
                    <p className="capacity">
                      <b className={fits ? 'fits' : 'over'}>
                        {formatBytes(needed)} of {formatBytes(capacity.usableBytes)}
                      </b>{' '}
                      · {writing_files.length.toLocaleString()} file
                      {writing_files.length === 1 ? '' : 's'}
                      {fits ? (
                        <> · fits, with {formatBytes(capacity.usableBytes - needed)} to spare</>
                      ) : (
                        <> · {formatBytes(needed - capacity.usableBytes)} too much</>
                      )}
                    </p>
                    {!fits && (
                      <div className="too-big">
                        <b>This profile will not fit on this stick</b>
                        <span>
                          Choose what to leave off — for this write only. The profile's own
                          folder is never changed.
                        </span>
                        <div className="too-big-actions">
                          <button
                            className="button secondary compact"
                            onClick={() => setPicking({ excluded: new Set(), steps: [] })}
                          >
                            <ListChecks />
                            Choose myself
                          </button>
                          <button
                            className="button secondary compact"
                            onClick={() => {
                              const proposal = proposeExclusions(held, profile!, capacity)
                              setPicking({
                                excluded: proposal.excluded,
                                steps: proposal.fits
                                  ? proposal.steps
                                  : [...proposal.steps, 'Even after all of that it does not fit.'],
                              })
                            }}
                          >
                            <Wand2 />
                            Choose for me
                          </button>
                          <button
                            className="button secondary compact"
                            onClick={() => setSelectedNode('')}
                          >
                            <X />
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {chosen && (
                      <p className="mode-note">
                        {(held.length - chosen.length).toLocaleString()} file
                        {held.length - chosen.length === 1 ? '' : 's'} left out of this write.{' '}
                        <button className="link-button" onClick={() => setChosen(null)}>
                          Put them back
                        </button>
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <div className="target-folder-choice">
                <span>{imagePath || 'No image chosen'}</span>
                <button
                  className="button secondary"
                  onClick={() =>
                    void chooseImageFile().then((path) => path && setImagePath(path))
                  }
                >
                  <Archive />
                  Choose image
                </button>
              </div>
            )}

            <div className="flow-actions">
              <button className="button" disabled={!canPlan || planning.busy} onClick={buildPlan}>
                {planning.busy ? 'Building plan' : 'Plan this write'}
              </button>
            </div>
            {planning.error && <p className="inline-error">{planning.error}</p>}

            {plan && (
              <section className="build-review" aria-label="Provisioning plan">
                <div>
                  <p className="eyebrow">This will erase the device</p>
                  <h3>
                    {formatBytes(plan.imageBytes)} will be written to {plan.device.node}
                  </h3>
                </div>

                <b>Everything below will be permanently lost</b>
                <ul className="plan-files">
                  {plan.destroys.map((entry) => (
                    <li key={entry.node}>
                      <b>{entry.node}</b> — {entry.description}
                    </li>
                  ))}
                </ul>

                <b>Steps</b>
                <ol className="plan-files">
                  {plan.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>

                {plan.warnings.map((warning) => (
                  <p className="inline-error" key={warning}>
                    {warning}
                  </p>
                ))}

                {plan.ready && (
                  <div className="build-review-confirm">
                    <label>
                      Type <b>{plan.confirmationPhrase}</b> to confirm
                      <input
                        value={confirmation}
                        onChange={(event) => setConfirmation(event.target.value)}
                        placeholder={plan.confirmationPhrase}
                      />
                    </label>
                    <button
                      className="button danger"
                      disabled={confirmation.trim() !== plan.confirmationPhrase || writing.busy}
                      onClick={write}
                    >
                      <Upload />
                      {writing.busy ? 'Writing and verifying' : 'Erase and write'}
                    </button>
                  </div>
                )}
              </section>
            )}

            {writing.error && (
              <div className="notice error">
                <X />
                {writing.error}
              </div>
            )}

            {report && (
              <InlineStatus kind="success">
                Wrote {formatBytes(report.bytesWritten)} to {report.device} and read every byte
                back to verify it.
              </InlineStatus>
            )}
          </>
        )}
      </section>

      {picking && profile && held && capacity && (
        <ContentsPicker
          profile={profile}
          files={held}
          capacity={capacity}
          initial={picking}
          close={() => setPicking(null)}
          confirm={(kept) => {
            setChosen(kept)
            setPicking(null)
          }}
        />
      )}

      {writing.busy && (
        <ProgressDialog
          title="Writing to the device"
          detail="Do not unplug the device. It is being written and will then be read back in full to verify."
        />
      )}
    </div>
  )
}
