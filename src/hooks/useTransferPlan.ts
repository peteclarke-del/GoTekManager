/**
 * Keeps a live transfer plan for the active profile.
 *
 * The hook takes the *same* request object that will later be executed. That
 * is deliberate: planning and applying must describe exactly the same change,
 * or the confirmation the user gave would not be the change that happens.
 *
 * Planning is read-only, so it can run freely whenever the collection or the
 * staged edits change. A `null` request means there is nothing to plan.
 */

import { useEffect, useState } from 'react'
import type { TransferPlan } from '../domain/types'
import { errorMessage, planTransfer, type TransferRequest } from '../native/commands'

export type PlanState = {
  plan: TransferPlan | null
  error: string
  /** True while a refresh is in flight; reported inline, never as a modal. */
  planning: boolean
}

export function useTransferPlan(request: TransferRequest | null): PlanState {
  const [plan, setPlan] = useState<TransferPlan | null>(null)
  const [error, setError] = useState('')
  const [planning, setPlanning] = useState(false)

  useEffect(() => {
    if (!request) {
      setPlan(null)
      setError('')
      setPlanning(false)
      return
    }
    let active = true
    setPlanning(true)
    setError('')
    planTransfer(request)
      .then((result) => active && setPlan(result))
      .catch((reason) => {
        if (!active) return
        setPlan(null)
        setError(errorMessage(reason))
      })
      .finally(() => {
        if (active) setPlanning(false)
      })
    return () => {
      active = false
    }
  }, [request])

  return { plan, error, planning }
}
