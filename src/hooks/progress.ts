/**
 * The two rules every progress indicator in the application follows.
 *
 * Each long-running native command reports its own shape of progress, but what
 * the window does with those reports is the same every time, and it is the sort
 * of agreement that drifts when it is written out separately in four places: an
 * indicator that lingers after its work is over looks like a hang, and one that
 * reads 100% before the last byte is written is a promise the application has
 * not yet kept.
 */

/** Work that is counted towards a known total. */
export type Counted = {
  done: number
  total: number
}

/**
 * The report, or nothing once the work is over.
 *
 * A finished batch clears itself rather than sitting on screen at its final
 * figure waiting to be dismissed.
 */
export function whileRunning<T extends Counted>(progress: T): T | null {
  return progress.done >= progress.total ? null : progress
}

/**
 * How far along, as a percentage, never claiming to be finished.
 *
 * Capped at 99 because the last step is the one most likely to be slow, and a
 * bar that sits at 100% while the application is still working reads as a
 * failure rather than as patience. Finishing is said by the indicator going
 * away, which is what {@link whileRunning} arranges.
 */
export function percentageOf(done: number, total: number): number {
  if (!total) return 0
  return Math.min(99, Math.round((done / total) * 100))
}
