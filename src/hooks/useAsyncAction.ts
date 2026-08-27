/**
 * Busy and error state for one asynchronous action.
 *
 * Every screen used to repeat the same try/catch/finally around native calls.
 * This keeps that in one place and guarantees the busy flag is always cleared,
 * including when the call throws.
 */

import { useCallback, useRef, useState } from 'react'
import { errorMessage } from '../native/commands'

export function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError('')
    try {
      return await work()
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
      return undefined
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])

  return { busy, error, setError, run }
}

/**
 * Tracks which item is currently working, so a table can disable one row's
 * button without blocking the rest of the interface.
 */
export function useBusyItem() {
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  const run = useCallback(async <T,>(id: string, work: () => Promise<T>) => {
    setBusyId(id)
    setError('')
    try {
      return await work()
    } catch (reason) {
      setError(errorMessage(reason))
      return undefined
    } finally {
      setBusyId('')
    }
  }, [])

  return { busyId, error, setError, run }
}
