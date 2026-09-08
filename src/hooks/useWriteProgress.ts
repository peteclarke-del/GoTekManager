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

import { useNativeEvent } from './useNativeEvent'

export type WriteProgress = {
  done: number
  total: number
  written: number
  bytes: number
  current: string
}

export function useWriteProgress(): WriteProgress | null {
  return useNativeEvent<WriteProgress>('write:progress', (progress) =>
    progress.done >= progress.total ? null : progress,
  )
}

/** How much of the write is done, by size, never claiming to be finished. */
export function writePercentage(progress: WriteProgress): number {
  if (!progress.bytes) return 0
  return Math.min(99, Math.round((progress.written / progress.bytes) * 100))
}
