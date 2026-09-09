/**
 * Draws a long table a page at a time.
 *
 * Every row of these tables carries a handful of controls, which is some tens
 * of elements of markup; a collection of twenty thousand is a few hundred
 * thousand of them, and building that many takes minutes during which nothing
 * on screen responds — including the tab that was clicked to get there. A page
 * draws in a moment, and the rest are one button away or, more usually, one
 * search away.
 *
 * The count resets whenever the list itself changes, so narrowing a filter
 * starts again from the top rather than leaving somebody scrolled past the end
 * of a shorter list.
 */

import { useEffect, useMemo, useState } from 'react'

/** How many rows are drawn at once. */
export const PAGE_SIZE = 150

export type PagedRows<T> = {
  visible: T[]
  /** How many are still undrawn, which is what the button offers to show. */
  remaining: number
  showMore: () => void
}

export function usePagedRows<T>(rows: readonly T[], pageSize = PAGE_SIZE): PagedRows<T> {
  const [shown, setShown] = useState(pageSize)

  useEffect(() => {
    setShown(pageSize)
  }, [rows, pageSize])

  const visible = useMemo(() => rows.slice(0, shown), [rows, shown])
  return {
    visible,
    remaining: rows.length - visible.length,
    showMore: () => setShown((count) => count + pageSize),
  }
}
