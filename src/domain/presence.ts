/**
 * How a library title compares with what is already on the destination.
 *
 * Presence is decided by contents rather than by name, so a title filed under
 * a different name in a different folder is still recognised as being there.
 * The vocabulary lives apart from the table that first showed it, because the
 * bulk scan asks the same question and must get the same answer.
 */

import type { FileStatus } from './types'

export type Presence =
  'Unchecked' | 'Checking' | 'New' | 'Identical' | 'Different' | 'Elsewhere' | 'Unavailable'

export const PRESENCE_BY_STATUS: Record<FileStatus, Presence> = {
  new: 'New',
  identical: 'Identical',
  different: 'Different',
  elsewhere: 'Elsewhere',
  unavailable: 'Unavailable',
}

/** Sort order for the target column: the most actionable state first. */
export const PRESENCE_ORDER: Presence[] = [
  'New',
  'Different',
  'Elsewhere',
  'Identical',
  'Unavailable',
  'Checking',
  'Unchecked',
]

/**
 * True when the destination holds these contents somewhere, whether or not it
 * is where this profile would write them.
 *
 * Unavailable counts as missing: whatever is wrong with it, it is not on the
 * media.
 */
export function isOnTarget(presence: Presence | FileStatus): boolean {
  const state =
    presence in PRESENCE_BY_STATUS
      ? PRESENCE_BY_STATUS[presence as FileStatus]
      : (presence as Presence)
  return state === 'Identical' || state === 'Elsewhere'
}
