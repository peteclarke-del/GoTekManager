/**
 * Progress while the application reads content fingerprints.
 *
 * Identity is the contents of a file, which means reading everything once. On a
 * library held on a network share that is not instant, and silence looks like a
 * hang, so the backend reports where it has got to and this surfaces it.
 */

import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isDesktop } from '../native/commands'

export type FingerprintProgress = {
  done: number
  total: number
  current: string
}

const EVENT = 'fingerprint:progress'

export function useFingerprintProgress(): FingerprintProgress | null {
  const [progress, setProgress] = useState<FingerprintProgress | null>(null)

  useEffect(() => {
    if (!isDesktop()) return
    let stop: (() => void) | undefined
    let active = true
    void listen<FingerprintProgress>(EVENT, (event) => {
      // A finished batch clears itself, so the indicator does not linger.
      setProgress(event.payload.done >= event.payload.total ? null : event.payload)
    }).then((unlisten) => {
      if (active) stop = unlisten
      else unlisten()
    })
    return () => {
      active = false
      stop?.()
    }
  }, [])

  return progress
}
