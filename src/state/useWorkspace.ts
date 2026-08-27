/** Wires the workspace reducer to persistence and derives the active profile. */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { defaultProviders } from '../domain/providers'
import { upsertById } from '../domain/records'
import type { AppSettings, OnlineProvider } from '../domain/types'
import { loadSettings, PROVIDERS_KEY, SETTINGS_KEY, TABLE_PREFS_KEY } from './migrations'
import { loadPersistedWorkspace, persistWorkspace } from './persistence.native'
import { readStored, usePersistentState } from './persistence'
import {
  activeProfileOf,
  collectionOf,
  emptyWorkspace,
  removalPolicyOf,
  workspaceReducer,
} from './workspace'

/** Coalesces a burst of edits into one transaction. */
const SAVE_DELAY_MS = 400

export function useWorkspace() {
  const [workspace, dispatch] = useReducer(workspaceReducer, emptyWorkspace)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Nothing is written back until the stored workspace has been read, or the
  // first render's empty state would overwrite the real library.
  const loaded = useRef(false)
  const pending = useRef<number | undefined>(undefined)

  useEffect(() => {
    let active = true
    loadPersistedWorkspace()
      .then((stored) => {
        if (!active) return
        dispatch({ type: 'workspaceLoaded', workspace: stored })
      })
      .catch((reason) => active && setError(String(reason)))
      .finally(() => {
        if (!active) return
        loaded.current = true
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!loaded.current) return
    // Saving is a whole-workspace transaction, so a burst of edits is worth
    // coalescing; the delay is short enough to survive an ordinary close.
    window.clearTimeout(pending.current)
    pending.current = window.setTimeout(() => {
      void persistWorkspace(workspace).catch((reason) => setError(String(reason)))
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(pending.current)
  }, [workspace])

  const activeProfile = activeProfileOf(workspace)
  const collection = collectionOf(workspace, activeProfile?.id)
  const removalPolicy = removalPolicyOf(workspace, activeProfile?.id)

  return { workspace, dispatch, activeProfile, collection, removalPolicy, loading, error }
}

export function useSettings() {
  return usePersistentState<AppSettings>(SETTINGS_KEY, loadSettings)
}

/**
 * Built-in providers are always present and always current; user-added sites
 * are stored separately and merged on top, so a future change to a built-in
 * definition reaches everyone.
 */
export function useProviders() {
  const [custom, setCustom] = usePersistentState<OnlineProvider[]>(PROVIDERS_KEY, () =>
    readStored<OnlineProvider[]>('gm.providers', []).filter((provider) => !provider.builtIn),
  )
  const providers = useMemo(() => upsertById(defaultProviders, ...custom), [custom])
  return [providers, setCustom] as const
}

export type TablePreferences = {
  sort: { key: string; direction: 'asc' | 'desc' }
  columnOrder: string[]
}

export const defaultTablePreferences: TablePreferences = {
  sort: { key: 'presence', direction: 'asc' },
  columnOrder: ['presence', 'title', 'platform', 'format', 'size', 'location', 'action'],
}

export function useTablePreferences() {
  return usePersistentState<TablePreferences>(TABLE_PREFS_KEY, defaultTablePreferences)
}
