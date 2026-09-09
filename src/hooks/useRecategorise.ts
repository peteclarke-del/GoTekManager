/**
 * Sorting, once, the titles a library was never able to sort.
 *
 * The rules that decide what a title is have improved several times, and a
 * library keeps the answer it was given when each title was indexed. That is
 * deliberate, because it is what makes a category somebody set by hand stick.
 * It also means an existing collection sees none of the improvement: a library
 * built before the source folder was read carries thousands of titles with no
 * category, and re-reading them all over a network share to collect something
 * the path already said is not a reasonable thing to ask.
 *
 * So this asks again, once per set of rules, for the titles that were never
 * sorted. It reads only those rows, a page at a time, and writes back only the
 * ones it can now answer.
 */

import { useEffect } from 'react'
import { categoriesToFill } from '../domain/recategorise'
import type { SourceLocation } from '../domain/types'
import { isDesktop } from '../native/commands'
import { uncategorisedItems, updateItems } from '../native/store'
import { itemsFromStored } from '../state/persistence.native'
import { readStored, writeStored } from '../state/persistence'

/**
 * Which set of category rules this library has already been asked about.
 *
 * Bump it whenever the rules learn to read something new, and every library
 * asks again about the titles it still has no answer for. Kept beside the
 * theme rather than in the library itself because it describes what has been
 * done to that library on this machine, and it has to be readable before
 * anything is drawn.
 */
const RULES = 2
const STAMP = 'gotek.categoryRules'

/**
 * How many rows are read at once.
 *
 * Large enough that a library with thousands of unsorted titles is a handful of
 * round trips, and small enough that the pass never holds much of the library
 * at once, which is the whole reason the library is queried rather than loaded.
 */
const PAGE = 2000

export function useRecategorise(sources: readonly SourceLocation[], ready: boolean) {
  useEffect(() => {
    if (!ready || !isDesktop()) return
    if (readStored<number>(STAMP, 0) === RULES) return
    // Nothing to read a source name from yet; the next start will do it.
    if (!sources.length) return

    let active = true
    void (async () => {
      for (let offset = 0; ;) {
        const page = await uncategorisedItems(PAGE, offset)
        if (!active) return
        if (!page.length) break

        const answers = categoriesToFill(itemsFromStored(page), sources)
        for (const [category, ids] of answers) {
          await updateItems(ids, { category })
          if (!active) return
        }

        // Only the rows this pass could not answer are still uncategorised, so
        // the next page starts after them rather than at the same place.
        offset += page.length - [...answers.values()].reduce((all, ids) => all + ids.length, 0)
        if (page.length < PAGE) break
      }
      writeStored(STAMP, RULES)
    })().catch(() => {
      // A library that could not be read now is one to try again next time, so
      // the stamp is deliberately not written. Nothing is shown: this is
      // housekeeping nobody asked for and a failure costs them nothing.
    })

    return () => {
      active = false
    }
  }, [ready, sources])
}
