import { Check, ChevronRight, HardDrive, Pencil } from 'lucide-react'
import { requireFirmware, requirePlatform } from '../../domain/catalog'
import { formatBytes } from '../../domain/media'
import { Empty } from '../../components/Feedback'
import type { Profile } from '../../domain/types'
import { isWritable } from '../../state/workspace'

const LAYOUT_LABELS: Record<Profile['folderLayout'], string> = {
  platform: 'Platform folders',
  category: 'Category folders',
  flat: 'Flat',
  custom: 'Custom folders',
}

export function ProfileStep({
  profiles,
  active,
  select,
  manageProfiles,
  next,
}: {
  profiles: Profile[]
  active?: Profile
  select: (id: string) => void
  manageProfiles: () => void
  next: () => void
}) {
  return (
    <section className="flow-profile panel">
      <div>
        <p className="eyebrow">1 · Select profile</p>
        <h2>What GoTek are you preparing?</h2>
        <p>
          A profile keeps the platform, firmware, drive layout, and destination
          together.
        </p>
      </div>

      {profiles.length ? (
        <div className="profile-choice-list">
          {profiles.map((profile) => {
            const selected = profile.id === active?.id
            return (
              <button
                key={profile.id}
                className={selected ? 'selected' : ''}
                aria-pressed={selected}
                onClick={() => select(profile.id)}
              >
                <HardDrive />
                <span>
                  <b>{profile.name}</b>
                  <small>
                    {requirePlatform(profile.platformId).name} ·{' '}
                    {requireFirmware(profile.firmwareId).name}
                  </small>
                  <small title={profile.destination.path}>{profile.destination.path}</small>
                </span>
                {selected && <Check />}
              </button>
            )
          })}
        </div>
      ) : (
        <Empty title="No profiles yet" action="Create profile" run={manageProfiles} />
      )}

      {active && (
        <div className="profile-facts">
          <div>
            <span>Platform</span>
            <b>{requirePlatform(active.platformId).name}</b>
          </div>
          <div>
            <span>Hardware / firmware</span>
            <b>{requireFirmware(active.firmwareId).name}</b>
          </div>
          <div>
            <span>Drive layout</span>
            <b>{active.organise ? LAYOUT_LABELS[active.folderLayout] : 'Unorganised'}</b>
          </div>
          <div>
            <span>File naming</span>
            <b>{active.naming === 'oled' ? 'OLED friendly' : 'Original'}</b>
          </div>
          {active.destination.availableBytes !== undefined && (
            <div>
              <span>Free space</span>
              <b>{formatBytes(active.destination.availableBytes)}</b>
            </div>
          )}
          <div className="profile-destination">
            <span>Destination</span>
            <b>{active.destination.path}</b>
          </div>
        </div>
      )}

      {active && !isWritable(active) && (
        <div className="notice info">
          This profile points at a FAT image. Its contents can be browsed, but nothing
          can be written to it yet.
        </div>
      )}

      <div className="flow-actions">
        <button className="button secondary" onClick={manageProfiles}>
          <Pencil />
          Manage profiles
        </button>
        <button className="button" disabled={!active} onClick={next}>
          View contents
          <ChevronRight />
        </button>
      </div>
    </section>
  )
}
