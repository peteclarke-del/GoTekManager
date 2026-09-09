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

import { percentageOf, whileRunning, type Counted } from './progress'
import { useNativeEvent } from './useNativeEvent'

export type PlanProgress = Counted

export function usePlanProgress(): PlanProgress | null {
  return useNativeEvent<PlanProgress>('plan:progress', whileRunning)
}

/** How far along the plan is, by the count of sources it has looked at. */
export function planPercentage(progress: PlanProgress): number {
  return percentageOf(progress.done, progress.total)
}
