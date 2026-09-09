/**
 * Progress while a source folder is being indexed.
 *
 * A TOSEC set of thirty thousand images on an SMB share takes minutes to walk
 * before a single title can be shown. Without this the application looks like
 * it ignored the folder, which is exactly what it was reported as doing. There
 * is no total to count towards — learning it would mean walking the tree twice
 * — so what is shown is what has been seen so far.
 */

import { useNativeEvent } from './useNativeEvent'

export type ScanProgress = {
  folders: number
  /** Folders found but not yet read, which is what gives the bar a length. */
  pending: number
  found: number
  current: string
  finished: boolean
}

export function useScanProgress(): ScanProgress | null {
  return useNativeEvent<ScanProgress>('scan:progress', (progress) =>
    progress.finished ? null : progress,
  )
}
