/**
 * Reading a transfer plan.
 *
 * The native planner returns one merged inventory; everything the interface
 * shows about a destination is derived here so the numbers in the summary tiles
 * and the rows in the table can never tell different stories.
 */

import { isSupportedExtension } from './catalog'
import { isOutsideProfile } from './media'
import { dottedExtensionOf } from './paths'
import { countBy } from './records'
import type {
  MediaItem,
  PlanBlocker,
  Profile,
  ResultStatus,
  TransferPlan,
  TransferResultEntry,
} from './types'

/**
 * True when this path already exists on the destination.
 *
 * Deliberately a loose comparison. An absent size means "this file is not there
 * yet", and treating a `null` that slipped through as a real size would count
 * every planned addition as an existing file.
 */
export function isOnDestination(entry: TransferResultEntry): boolean {
  return entry.currentSize != null
}

export type PlanSummary = {
  /** Recognised media only; firmware configuration files are not counted. */
  entries: TransferResultEntry[]
  counts: Record<ResultStatus, number>
  /** How many recognised images the destination holds right now. */
  currentCount: number
  /** How many it will hold once the plan is applied. */
  resultCount: number
  /** Files present that this profile's drive cannot load, kept and flagged. */
  mismatches: TransferResultEntry[]
  mismatchFormats: string[]
  hasChanges: boolean
}

const NO_COUNTS: Record<ResultStatus, number> = {
  add: 0,
  unchanged: 0,
  move: 0,
  remove: 0,
  conflict: 0,
}

export const emptyPlanSummary: PlanSummary = {
  entries: [],
  counts: NO_COUNTS,
  currentCount: 0,
  resultCount: 0,
  mismatches: [],
  mismatchFormats: [],
  hasChanges: false,
}

/**
 * The staged titles standing in the way of a write, grouped by what is wrong.
 *
 * A plan that cannot be written is not a dead end, it is a short list of things
 * to take back out: a title whose file has gone, one that changed underneath
 * the library, or the second of two that would be written to the same name.
 * Naming them is what lets the step offer to do it rather than leaving someone
 * at a button that will not light up.
 *
 * A collision names the *later* of the pair, because the first claim on a path
 * is the one the rest of the plan is built around.
 */
export function blockedTitles(
  plan: TransferPlan | null,
  itemsBySource: Map<string, MediaItem>,
): { kind: PlanBlocker['kind']; item: MediaItem; message: string }[] {
  const seen = new Set<string>()
  return (plan?.blockers ?? []).flatMap((blocker) => {
    if (!blocker.source || seen.has(blocker.source)) return []
    const item = itemsBySource.get(blocker.source)
    if (!item) return []
    seen.add(blocker.source)
    return [{ kind: blocker.kind, item, message: blocker.message }]
  })
}

export function summarisePlan(
  plan: TransferPlan | null,
  profile: Profile | undefined,
): PlanSummary {
  if (!plan || !profile) return emptyPlanSummary

  const entries = plan.result.filter((entry) =>
    isSupportedExtension(dottedExtensionOf(entry.path)),
  )
  const counts = { ...NO_COUNTS, ...countBy(entries, (entry) => entry.status) }
  const mismatches = entries.filter(
    (entry) => isOnDestination(entry) && isOutsideProfile(profile, entry.path),
  )

  return {
    entries,
    counts,
    currentCount: entries.filter(isOnDestination).length,
    resultCount: entries.filter((entry) => entry.status !== 'remove').length,
    mismatches,
    mismatchFormats: [...new Set(mismatches.map((entry) => dottedExtensionOf(entry.path)))],
    hasChanges: counts.add + counts.move + counts.remove > 0,
  }
}
