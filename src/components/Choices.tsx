import { Check, HardDrive } from 'lucide-react'
import { requireFirmware, requirePlatform } from '../domain/catalog'
import type { Profile } from '../domain/types'

/**
 * The choices in a `<select>`, for the shape almost every list in the
 * application already has.
 *
 * Eleven selects spelled the same three lines out: map the list, key on the id,
 * show the name. Nothing was ever wrong with any of them, which is rather the
 * point. This is markup rather than a decision, and it belongs somewhere it can
 * be read once.
 */
export function Options({ items }: { items: ReadonlyArray<{ id: string; name: string }> }) {
  return (
    <>
      {items.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </>
  )
}

/**
 * One profile, as something to pick from a list.
 *
 * The profiles screen and the first step of the guided flow both offer the same
 * choice and drew it twice, differing only in whether the destination was shown
 * underneath. Two copies of a list of profiles is how the two screens come to
 * describe the same profile differently.
 */
export function ProfileChoice({
  profile,
  selected,
  onSelect,
  showDestination = false,
}: {
  profile: Profile
  selected: boolean
  onSelect: () => void
  /** The guided flow shows where the profile writes; the profiles screen has it
   * on the panel beside the list already. */
  showDestination?: boolean
}) {
  return (
    <button className={selected ? 'selected' : ''} aria-pressed={selected} onClick={onSelect}>
      <HardDrive />
      <span>
        <b>{profile.name}</b>
        <small>
          {requirePlatform(profile.platformId).name} ·{' '}
          {requireFirmware(profile.firmwareId).name}
        </small>
        {showDestination && (
          <small title={profile.destination.path}>{profile.destination.path}</small>
        )}
      </span>
      {selected && <Check className="selection-check" />}
    </button>
  )
}
