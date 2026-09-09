/**
 * Asking again about titles the library never sorted.
 *
 * A title's category is worked out when it is indexed and then kept, which is
 * what lets somebody correct one by hand and have the correction stick. The
 * cost of keeping it is that a library carries the answers the rules gave at
 * the time, and the rules improve: reading a folder named after a collection's
 * own catalogue, reading an archive's name, and reading the source folder all
 * arrived after libraries had already been built. A collection indexed before
 * them keeps thousands of titles with no category at all, and the only way out
 * was to re-read every file over a network share, which is not a reasonable
 * thing to ask.
 *
 * So the titles that were never sorted are asked again. Only those: a category
 * that says something, whether the rules worked it out or a person chose it, is
 * never touched, because there is no way to tell those two apart afterwards and
 * overwriting somebody's decision is worse than leaving a title unsorted.
 */

import { inferCategoryFor } from './categories'
import { namesOf } from './media'
import type { MediaItem, SourceLocation } from './types'

/**
 * Which titles can now be sorted, gathered by the category they belong to.
 *
 * Grouped rather than listed one by one because that is the shape the store
 * wants: one statement per category, naming the rows it applies to, rather than
 * a write per title.
 */
export function categoriesToFill(
  items: readonly MediaItem[],
  sources: readonly SourceLocation[],
): Map<string, string[]> {
  const named = new Map(sources.map((source) => [source.path, source.name]))
  const found = new Map<string, string[]>()

  for (const item of items) {
    // Already answered, by the rules or by somebody. Left alone.
    if (item.category) continue
    const category = inferCategoryFor(
      item.path,
      { path: item.source, name: named.get(item.source) },
      ...namesOf(item),
    )
    if (!category) continue
    const held = found.get(category)
    if (held) held.push(item.id)
    else found.set(category, [item.id])
  }

  return found
}
