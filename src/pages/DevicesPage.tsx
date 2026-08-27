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
  RefreshCw,
  ShieldAlert,
  Upload,
  X,
} from 'lucide-react'
import { Empty, InlineStatus, ProgressDialog } from '../components/Feedback'
import { formatBytes, managedFormats, transferOperations } from '../domain/media'
import type {
  ImageOptions,
  MediaItem,
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
  physicalDevices,
  planProvision,
  type ProvisionRequest,
  type ProvisionSource,
} from '../native/commands'

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
      {usable ? <HardDrive /> : <ShieldAlert />}
      <span>
        <b>{device.name}</b>
        <small>
          {device.node} · {formatBytes(device.sizeBytes)}
          {device.transport ? ` · ${device.transport}` : ''}
          {device.removable ? ' · removable' : ''}
          {device.serial ? ` · serial ${device.serial}` : ' · no serial reported'}
        </small>
        <small>
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
  profile,
  collection,
  notify,
}: {
  profile?: Profile
  collection: MediaItem[]
  notify: (notice: Notice) => void
}) {
  const [devices, setDevices] = useState<PhysicalDevice[]>([])
  const [selectedNode, setSelectedNode] = useState('')
  const [sourceKind, setSourceKind] = useState<'build' | 'image'>('build')
  const [imagePath, setImagePath] = useState('')
  const [plan, setPlan] = useState<ProvisionPlan | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [report, setReport] = useState<ProvisionReport | null>(null)
  const scan = useAsyncAction()
  const planning = useAsyncAction()
  const writing = useAsyncAction()

  const selected = devices.find((device) => device.node === selectedNode)

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

  const operations = useMemo(
    () => (profile ? transferOperations(collection, profile) : []),
    [collection, profile],
  )

  const source = (): ProvisionSource | null => {
    if (sourceKind === 'image') {
      return imagePath ? { kind: 'image', path: imagePath } : null
    }
    if (!selected || !profile) return null
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
    (sourceKind === 'image' ? Boolean(imagePath) : Boolean(profile) && operations.length > 0)

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
        {scan.error && <p className="inline-error">{scan.error}</p>}
        <div className="managed-targets setup-scroll-list" aria-label="Storage devices">
          {devices.map((device) => (
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
              <button
                type="button"
                className={sourceKind === 'build' ? 'active' : ''}
                aria-pressed={sourceKind === 'build'}
                onClick={() => setSourceKind('build')}
              >
                Build from this profile
              </button>
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
              <p className="mode-note">
                {profile
                  ? `A fresh FAT volume labelled “${profile.name}” holding the ${operations.length} title${operations.length === 1 ? '' : 's'} staged for this profile, laid out by its own folder and naming rules. Formats: ${managedFormats(profile).join(', ')}.`
                  : 'Create a profile first: the layout and naming rules come from it.'}
              </p>
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

      {writing.busy && (
        <ProgressDialog
          title="Writing to the device"
          detail="Do not unplug the device. It is being written and will then be read back in full to verify."
        />
      )}
    </div>
  )
}
