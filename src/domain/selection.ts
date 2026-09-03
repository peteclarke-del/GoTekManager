/**
 * The set algebra behind a table's tick boxes.
 *
 * Every pane that lists disk images needs the same four gestures: tick one row,
 * tick a run of them, tick everything currently shown, and forget the ticks on
 * rows that a filter has since hidden. Those rules live here, apart from the
 * React that draws them, so each pane inherits the same behaviour and the rules
 * themselves can be checked without rendering anything.
 */

/** Whether the ticks cover none, some, or all of the rows on screen. */
export type Coverage = 'none' | 'some' | 'all'

/** Ticks a row that is not ticked, and unticks one that is. */
export function toggled(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (!next.delete(id)) next.add(id)
  return next
}

/** Ticks or unticks a whole group of rows in one go. */
export function withAll(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(selected)
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}

/**
 * The rows between two others, inclusive, in the order they are displayed.
 *
 * Either end having scrolled out of the list — filtered away between the two
 * clicks, say — leaves nothing to extend across, which is reported as an empty
 * run rather than a guess at what was meant.
 */
export function rangeOf(
  ids: readonly string[],
  anchor: string,
  id: string,
): string[] {
  const from = ids.indexOf(anchor)
  const to = ids.indexOf(id)
  if (from < 0 || to < 0) return []
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/**
 * Drops ticks for rows that are no longer listed.
 *
 * A bulk action must only ever touch what the user can see, so narrowing a
 * filter narrows the selection with it. When nothing is dropped the set that
 * was passed in is returned unchanged, which lets a caller compare by identity
 * and avoid a pointless render.
 */
export function retained(
  selected: ReadonlySet<string>,
  ids: readonly string[],
): ReadonlySet<string> {
  if (!selected.size) return selected
  const listed = new Set(ids)
  const kept = new Set([...selected].filter((id) => listed.has(id)))
  return kept.size === selected.size ? selected : kept
}

export function coverageOf(
  selected: ReadonlySet<string>,
  ids: readonly string[],
): Coverage {
  if (!ids.length) return 'none'
  const ticked = ids.filter((id) => selected.has(id)).length
  if (!ticked) return 'none'
  return ticked === ids.length ? 'all' : 'some'
}
