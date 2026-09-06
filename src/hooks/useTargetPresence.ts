/**
 * Comparing a library against a profile's destination.
 *
 * Whether a title is already on the media is decided by its contents, which
 * means reading every one: exact, and not free. For a few hundred that is a
 * moment; for a few thousand — a library of archived titles on a network share,
 * say — it is minutes, and doing it the instant a screen opens looks like the
 * application has hung. So beyond a limit the check is offered rather than
 * taken, and the rule lives here so every screen that asks the question asks it
 * the same way and gets the same answer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { belongsToPlatform, forProfile, transferOperations } from '../domain/media'
import type { MediaItem, Profile, TargetFileStatus } from '../domain/types'
import { compareTargetFiles } from '../native/commands'

/** How many titles are compared with the destination without being asked. */
export const AUTOMATIC_CHECK_LIMIT = 500

export type TargetPresence = {
  /** What the destination holds, by the title's own path. */
  statuses: Record<string, TargetFileStatus>
  checking: boolean
  /** Whether an answer exists, or is being worked out, at all. */
  checked: boolean
  /** True when the library is small enough to compare without being asked. */
  automatic: boolean
  /** The titles this profile would compare: its machine's, committed to it. */
  comparable: MediaItem[]
  /** Runs a comparison the user has asked for. */
  askForCheck: () => void
}

export function useTargetPresence(
  profile: Profile,
  items: readonly MediaItem[],
  platformId: string,
): TargetPresence {
  const [statuses, setStatuses] = useState<Record<string, TargetFileStatus>>({})
  const [checking, setChecking] = useState(false)
  /** Set once the user asks for a comparison too large to run unprompted. */
  const [checkAsked, setCheckAsked] = useState(false)

  // Comparing every title with the destination is exact but not free, so it
  // runs once per profile and library change rather than on every keystroke.
  const comparable = useMemo(
    () =>
      items
        .filter((item) => belongsToPlatform(item, platformId))
        // Compare against the path the title would actually be written to,
        // which for an unassigned title means this profile's platform folder.
        .map((item) => forProfile(item, platformId)),
    [items, platformId],
  )

  const automatic = comparable.length <= AUTOMATIC_CHECK_LIMIT
  const checked = automatic || checkAsked

  // A different destination is a different answer, so an answer already given
  // is not carried across to one that has not been asked for.
  useEffect(() => {
    setCheckAsked(false)
    setStatuses({})
  }, [profile.id, platformId])

  useEffect(() => {
    let active = true
    if (!comparable.length || !checked) {
      setStatuses({})
      return
    }
    setChecking(true)
    compareTargetFiles(profile.destination.path, transferOperations(comparable, profile))
      .then((results) => {
        if (!active) return
        setStatuses(Object.fromEntries(results.map((entry) => [entry.source, entry])))
      })
      .catch(() => active && setStatuses({}))
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [
    comparable,
    checked,
    profile.destination.path,
    profile.firmwareId,
    profile.organise,
    profile.folderLayout,
    profile.folderTemplate,
    profile.naming,
    profile.categoryFolders,
  ])

  const askForCheck = useCallback(() => setCheckAsked(true), [])

  return { statuses, checking, checked, automatic, comparable, askForCheck }
}
