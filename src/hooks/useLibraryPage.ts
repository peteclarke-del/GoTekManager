/**
 * One page of the library, asked for rather than filtered in the window.
 *
 * The table used to be a `useMemo` over every title the user owns: filter,
 * then sort, then draw. That is fine for a folder of demos and hopeless for a
 * TOSEC set — it re-sorts tens of thousands of rows on every keystroke, and it
 * cannot begin until the whole collection has crossed into the window.
 *
 * So the question goes to the database instead, where the index is, and what
 * comes back is the page being drawn plus the counts that describe the rest.
 */

import { useEffect, useRef, useState } from 'react'
import { isDesktop } from '../native/commands'
import { queryItems, type ItemQuery } from '../native/store'
import { itemsFromStored } from '../state/persistence.native'
import type { MediaItem } from '../domain/types'

export type LibraryPage = {
  rows: MediaItem[]
  /** How many titles match the filter, of which `rows` is one page. */
  total: number
  /** How many each source contributes, for the sidebar's counts. */
  bySource: Record<string, number>
  loading: boolean
  error: string
}

const EMPTY: LibraryPage = {
  rows: [],
  total: 0,
  bySource: {},
  loading: false,
  error: '',
}

/**
 * Waits for typing to settle before asking.
 *
 * Long enough that a search phrase is one query rather than one per letter,
 * short enough that the table does not feel like it is lagging behind.
 */
const SETTLE_MS = 200

export function useLibraryPage(
  query: ItemQuery,
  /**
   * Bumped whenever the library itself changes. The query is the question and
   * this is the other reason the answer moves: a scan that writes four thousand
   * rows leaves the question exactly as it was.
   */
  revision = 0,
): LibraryPage {
  const [page, setPage] = useState<LibraryPage>({ ...EMPTY, loading: isDesktop() })
  // Compared rather than kept: the caller builds a fresh object every render,
  // so asking whether it *says* the same thing is the only stable test.
  const asked = JSON.stringify(query)
  // Answers can arrive out of order — a short query after a long one — and the
  // newest question is the only one whose answer should be shown.
  const latest = useRef(0)

  useEffect(() => {
    if (!isDesktop()) return
    const mine = (latest.current += 1)
    const timer = window.setTimeout(() => {
      setPage((current) => ({ ...current, loading: true }))
      queryItems(JSON.parse(asked) as ItemQuery)
        .then((answer) => {
          if (latest.current !== mine) return
          setPage({
            rows: itemsFromStored(answer.rows),
            total: answer.total,
            bySource: answer.bySource,
            loading: false,
            error: '',
          })
        })
        .catch((reason) => {
          if (latest.current !== mine) return
          setPage({ ...EMPTY, error: String(reason) })
        })
    }, SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [asked, revision])

  return page
}
