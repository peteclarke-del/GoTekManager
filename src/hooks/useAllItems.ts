/**
 * Every title for one machine, read a page at a time.
 *
 * Almost nothing needs the whole library, which is why it is no longer carried
 * about; the bulk add is the exception, because deciding which release of a
 * title to take means having seen all of them. So it reads the library rather
 * than being handed it, and only when somebody opens the dialog.
 *
 * Reading it in pages matters for more than memory: a single answer of tens of
 * megabytes is seconds of silence with nothing to show, whereas a page at a
 * time can say how far it has got.
 */

import { useEffect, useState } from 'react'
import { isDesktop } from '../native/commands'
import { queryItems } from '../native/store'
import { itemsFromStored } from '../state/persistence.native'
import type { MediaItem } from '../domain/types'

/**
 * How many titles are read at once.
 *
 * Large enough that a big library is tens of round trips rather than hundreds,
 * small enough that each one crosses quickly and the count keeps moving.
 */
const PER_PAGE = 5000

export type AllItems = {
  items: MediaItem[]
  /** How many have arrived, and how many there are in total. */
  read: number
  total: number
  loading: boolean
  error: string
}

export function useAllItems(
  platformId: string,
  enabled = true,
  /**
   * Bumped when the library changes. Without it, re-indexing every source from
   * inside the bulk add would leave the preview describing the library as it
   * was when the dialog opened, which for a library that was empty then is a
   * scan that appears to have found nothing.
   */
  revision = 0,
): AllItems {
  const [state, setState] = useState<AllItems>({
    items: [],
    read: 0,
    total: 0,
    loading: enabled,
    error: '',
  })

  useEffect(() => {
    if (!enabled || !isDesktop()) {
      setState({ items: [], read: 0, total: 0, loading: false, error: '' })
      return
    }
    let active = true
    setState({ items: [], read: 0, total: 0, loading: true, error: '' })

    const readFrom = async () => {
      const collected: MediaItem[] = []
      let offset = 0
      for (;;) {
        const page = await queryItems({ platformId, offset, limit: PER_PAGE })
        if (!active) return
        collected.push(...itemsFromStored(page.rows))
        offset += page.rows.length
        setState({
          // A copy each time, so the dialog can show what has arrived rather
          // than waiting for the last page before anything appears.
          items: [...collected],
          read: collected.length,
          total: page.total,
          loading: collected.length < page.total && page.rows.length > 0,
          error: '',
        })
        // The second guard matters: a library that shrinks between pages would
        // otherwise never reach its own total and read for ever.
        if (collected.length >= page.total || page.rows.length === 0) return
      }
    }

    void readFrom().catch((reason) => {
      if (!active) return
      setState({ items: [], read: 0, total: 0, loading: false, error: String(reason) })
    })

    return () => {
      active = false
    }
  }, [platformId, enabled, revision])

  return state
}
