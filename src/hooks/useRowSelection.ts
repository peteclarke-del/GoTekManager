/**
 * Multi-selection for one table of rows.
 *
 * The hook is given the ids currently on screen, in display order, and owns
 * everything else: which are ticked, the run a shift-click extends across, and
 * the pruning that happens when a filter hides a ticked row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  coverageOf,
  rangeOf,
  retained,
  toggled,
  withAll,
  type Coverage,
} from '../domain/selection'

export type RowSelection = {
  selected: ReadonlySet<string>
  /** How many rows on screen are ticked. */
  count: number
  /** How many rows are on screen at all. */
  total: number
  coverage: Coverage
  isSelected: (id: string) => boolean
  /** Ticks one row; with `extend`, every row between it and the last ticked. */
  toggle: (id: string, extend?: boolean) => void
  /** Ticks everything shown, or clears it when everything already is. */
  toggleAll: () => void
  clear: () => void
  /** The ticked rows, in display order, as the caller's own objects. */
  chosen: <T>(rows: readonly T[], idOf: (row: T) => string) => T[]
}

export function useRowSelection(ids: readonly string[]): RowSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  /** The row a shift-click measures its run from. */
  const anchor = useRef('')
  // Callbacks are handed to every row, so they must not be rebuilt whenever the
  // list changes; the current rows are read from here instead.
  const listed = useRef(ids)
  listed.current = ids

  // A tick on a row a filter has since hidden would be acted on invisibly, so
  // the selection is narrowed with the list rather than kept behind it.
  useEffect(() => {
    setSelected((current) => retained(current, ids))
  }, [ids])

  const toggle = useCallback((id: string, extend = false) => {
    const run = extend && anchor.current ? rangeOf(listed.current, anchor.current, id) : []
    setSelected((current) =>
      run.length ? withAll(current, run, !current.has(id)) : toggled(current, id),
    )
    anchor.current = id
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((current) =>
      withAll(current, listed.current, coverageOf(current, listed.current) !== 'all'),
    )
    anchor.current = ''
  }, [])

  const clear = useCallback(() => {
    setSelected(new Set<string>())
    anchor.current = ''
  }, [])

  const isSelected = useCallback((id: string) => selected.has(id), [selected])

  const chosen = useCallback(
    <T,>(rows: readonly T[], idOf: (row: T) => string) =>
      rows.filter((row) => selected.has(idOf(row))),
    [selected],
  )

  const count = useMemo(
    () => ids.filter((id) => selected.has(id)).length,
    [ids, selected],
  )

  return {
    selected,
    count,
    total: ids.length,
    coverage: coverageOf(selected, ids),
    isSelected,
    toggle,
    toggleAll,
    clear,
    chosen,
  }
}
