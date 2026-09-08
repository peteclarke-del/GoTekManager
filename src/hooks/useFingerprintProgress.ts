/**
 * Progress while the application reads content fingerprints.
 *
 * Identity is the contents of a file, which means reading everything once. On a
 * library held on a network share that is not instant, and silence looks like a
 * hang, so the backend reports where it has got to and this surfaces it.
 */

import { useNativeEvent } from './useNativeEvent'

export type FingerprintProgress = {
  done: number
  total: number
  current: string
}

export function useFingerprintProgress(): FingerprintProgress | null {
  return useNativeEvent<FingerprintProgress>('fingerprint:progress', (progress) =>
    // A finished batch clears itself, so the indicator does not linger.
    progress.done >= progress.total ? null : progress,
  )
}
