/**
 * Profiles waiting to be confirmed before they exist.
 *
 * A destination on its own does not say which machine it is for: the platform
 * can only be guessed from the folder or volume name, and a guess that lands
 * silently is one the user finds out about when the wrong titles are offered.
 * So a chosen destination becomes a *draft*, shown in the editor, and only
 * becomes a profile when it is accepted.
 *
 * Drafts queue because discovering mounted storage can offer several at once,
 * and each of them is a separate machine to name.
 */

import { useCallback, useState } from 'react'
import type { Profile } from '../domain/types'

export type ProfileDrafts = {
  /** The draft awaiting an answer, if any. */
  current?: Profile
  /** How many are still queued behind this one. */
  waiting: number
  propose: (profiles: Profile[]) => void
  accept: (profile: Profile) => void
  discard: () => void
}

export function useProfileDrafts(create: (profile: Profile) => void): ProfileDrafts {
  const [queue, setQueue] = useState<Profile[]>([])

  const propose = useCallback(
    (profiles: Profile[]) => setQueue((current) => [...current, ...profiles]),
    [],
  )

  const discard = useCallback(() => setQueue((current) => current.slice(1)), [])

  const accept = useCallback(
    (profile: Profile) => {
      create(profile)
      setQueue((current) => current.slice(1))
    },
    [create],
  )

  return { current: queue[0], waiting: Math.max(0, queue.length - 1), propose, accept, discard }
}
