/** Wires the workspace reducer to persistence and derives the active profile. */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  defaultProviders,
  mergeProviders,
  PROVIDERS_FILE,
  readCustomProviders,
  readProviderConfig,
} from '../domain/providers'
import type { AppSettings, OnlineProvider } from '../domain/types'
import {
  loadSettings,
  PROVIDERS_KEY,
  reviveSettings,
  SETTINGS_KEY,
  TABLE_PREFS_KEY,
} from './migrations'
import { loadPersistedWorkspace, persistWorkspace } from './persistence.native'
import { isDesktop, readConfigFile } from '../native/commands'
import { readStored, usePersistentState } from './persistence'
import {
  activeProfileOf,
  collectionOf,
  emptyWorkspace,
  removalPolicyOf,
  workspaceReducer,
  type Workspace,
} from './workspace'

/** Coalesces a burst of edits into one transaction. */
const SAVE_DELAY_MS = 400

export function useWorkspace() {
  const [workspace, dispatch] = useReducer(workspaceReducer, emptyWorkspace)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Nothing is written back until the stored workspace has been read, or the
  // first render's empty state would overwrite the real library. The workspace
  // that was read is kept as well: settling it into state is a change like any
  // other, so without this every start ends by writing back, unaltered, the
  // tens of thousands of rows it has just finished reading — seconds of work
  // for a result already on disk.
  const loaded = useRef<Workspace | undefined>(undefined)
  const pending = useRef<number | undefined>(undefined)
  // One save at a time, and only the newest one waiting. A whole-workspace
  // transaction over a large library takes seconds, which is longer than the
  // debounce, so without this a steady stream of edits starts transactions
  // faster than they finish: they queue against each other in the database and
  // every one but the last is written for nothing.
  const saving = useRef(false)
  const queued = useRef<Workspace | undefined>(undefined)

  useEffect(() => {
    let active = true
    loadPersistedWorkspace()
      .then((stored) => {
        if (!active) return
        loaded.current = stored
        dispatch({ type: 'workspaceLoaded', workspace: stored })
      })
      .catch((reason) => active && setError(String(reason)))
      .finally(() => {
        if (!active) return
        loaded.current = loaded.current ?? emptyWorkspace
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  /**
   * Writes whatever is waiting, then whatever arrived while it was writing.
   *
   * Only the newest workspace is ever kept, because each save replaces the
   * stored workspace entirely: an older one that has been superseded has
   * nothing left to contribute.
   */
  const drain = useCallback(async () => {
    if (saving.current) return
    saving.current = true
    try {
      while (queued.current) {
        const next = queued.current
        queued.current = undefined
        try {
          await persistWorkspace(next)
        } catch (reason) {
          setError(String(reason))
        }
      }
    } finally {
      saving.current = false
    }
  }, [])

  useEffect(() => {
    // Not until the stored workspace has been read, and not to write it
    // straight back out again unchanged.
    if (!loaded.current || workspace === loaded.current) return
    // Saving is a whole-workspace transaction, so a burst of edits is worth
    // coalescing; the delay is short enough to survive an ordinary close.
    window.clearTimeout(pending.current)
    pending.current = window.setTimeout(() => {
      queued.current = workspace
      void drain()
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(pending.current)
  }, [workspace, drain])

  const activeProfile = activeProfileOf(workspace)
  const collection = collectionOf(workspace, activeProfile?.id)
  const removalPolicy = removalPolicyOf(workspace, activeProfile?.id)

  return { workspace, dispatch, activeProfile, collection, removalPolicy, loading, error }
}

export function useSettings() {
  return usePersistentState<AppSettings>(SETTINGS_KEY, loadSettings, reviveSettings)
}

/**
 * The shipped list, a hand-written override if there is one, and the user's own
 * sites on top.
 *
 * The override is read once at startup. A file that cannot be parsed, or whose
 * entries are unusable, leaves the bundled list in place and reports why rather
 * than starting with no sources and no explanation.
 */
export function useProviders() {
  const [custom, setCustom] = usePersistentState<OnlineProvider[]>(PROVIDERS_KEY, () =>
    readStored<OnlineProvider[]>('gm.providers', []).filter((provider) => !provider.builtIn),
  )
  const [shipped, setShipped] = useState<OnlineProvider[]>(defaultProviders)
  const [configPath, setConfigPath] = useState('')
  const [problems, setProblems] = useState<string[]>([])

  useEffect(() => {
    if (!isDesktop()) return
    let active = true
    readConfigFile(PROVIDERS_FILE)
      .then((file) => {
        if (!active) return
        setConfigPath(file.path)
        if (!file.contents?.trim()) return
        try {
          const load = readProviderConfig(JSON.parse(file.contents))
          setProblems(load.problems)
          if (load.providers.length) setShipped(load.providers)
          else setProblems((current) => [...current, 'no usable sources; keeping the built-in list'])
        } catch (reason) {
          setProblems([`${PROVIDERS_FILE} is not valid JSON: ${String(reason)}`])
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  // The user's own sources are checked the same way the shipped list is, so a
  // source that no longer passes is named rather than quietly disappearing.
  const mine = useMemo(() => readCustomProviders(custom), [custom])
  const providers = useMemo(
    () => mergeProviders(shipped, mine.providers),
    [shipped, mine.providers],
  )
  return {
    providers,
    setCustom,
    configPath,
    problems: [...problems, ...mine.problems],
  }
}

export type TablePreferences = {
  sort: { key: string; direction: 'asc' | 'desc' }
  columnOrder: string[]
}

export const defaultTablePreferences: TablePreferences = {
  sort: { key: 'presence', direction: 'asc' },
  columnOrder: [
    'presence',
    'title',
    'platform',
    'category',
    'format',
    'size',
    'location',
    'action',
  ],
}

/**
 * The stored column order, with any column it predates.
 *
 * The order is the user's, so it is kept as it was found; a column added since
 * it was saved is appended rather than dropped, which is what stops a new one
 * from being invisible to everyone who has used the application before.
 */
export function reviveTablePreferences(stored: Partial<TablePreferences>): TablePreferences {
  const merged = { ...defaultTablePreferences, ...stored }
  const known = new Set(defaultTablePreferences.columnOrder)
  const kept = merged.columnOrder.filter((column) => known.has(column))
  const missing = defaultTablePreferences.columnOrder.filter(
    (column) => !kept.includes(column),
  )
  // The action column is the row's own control and belongs at the end.
  const columnOrder = [...kept, ...missing].filter((column) => column !== 'action')
  return { ...merged, columnOrder: [...columnOrder, 'action'] }
}

export function useTablePreferences() {
  return usePersistentState<TablePreferences>(
    TABLE_PREFS_KEY,
    defaultTablePreferences,
    reviveTablePreferences,
  )
}
