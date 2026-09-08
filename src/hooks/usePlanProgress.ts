/**
 * Progress while a transfer plan is being worked out.
 *
 * Planning a handful of titles is instant. Planning ten thousand held on a
 * network share is not: every source has to be found before the plan can say
 * whether it is writable, and that is thousands of round trips during which the
 * interface has nothing to show. Unlike a directory walk this one knows its own
 * length, so it reports a true proportion rather than a moving stripe.
 *
 * Nothing arrives for a short plan, which is what keeps a dialog from flashing
 * up for work that was over before it was drawn.
 */

import { useNativeEvent } from './useNativeEvent'

export type PlanProgress = {
  done: number
  total: number
}

export function usePlanProgress(): PlanProgress | null {
  return useNativeEvent<PlanProgress>('plan:progress', (progress) =>
    progress.done >= progress.total ? null : progress,
  )
}

/** How far along, as a percentage, never claiming to be finished. */
export function planPercentage(progress: PlanProgress): number {
  if (!progress.total) return 0
  return Math.min(99, Math.round((progress.done / progress.total) * 100))
}
