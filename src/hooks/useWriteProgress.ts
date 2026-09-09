/**
 * Progress while the staged titles are being written.
 *
 * Copying is the long half of applying — gigabytes read out of archives on a
 * network share and verified as they land — and it reported nothing at all, so
 * the last thing on screen was the planning dialog sitting at its final
 * percentage while the write ran on invisibly behind it.
 *
 * Measured in bytes rather than files, because the files are not the same size
 * and a count of them crawls and leaps.
 */

import { percentageOf, whileRunning, type Counted } from './progress'
import { useNativeEvent } from './useNativeEvent'

export type WriteProgress = Counted & {
  /** Bytes written so far, and how many there are, which is what the bar shows. */
  written: number
  bytes: number
  current: string
}

export function useWriteProgress(): WriteProgress | null {
  return useNativeEvent<WriteProgress>('write:progress', whileRunning)
}

/** How much of the write is done, by size rather than by the count of files. */
export function writePercentage(progress: WriteProgress): number {
  return percentageOf(progress.written, progress.bytes)
}
