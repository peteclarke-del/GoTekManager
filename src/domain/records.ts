/** Small immutable helpers for the collection shapes the state uses. */

export type Identified = { id: string }

/**
 * Merges items into a list keyed by id, keeping the first occurrence's position
 * and the last occurrence's value.
 */
export function upsertById<T extends Identified>(list: readonly T[], ...added: T[]): T[] {
  return [...new Map([...list, ...added].map((item) => [item.id, item])).values()]
}

/** Drops one item, or a whole selection of them, keeping the rest in order. */
export function removeById<T extends Identified>(list: readonly T[], ...ids: string[]): T[] {
  const dropped = new Set(ids)
  return list.filter((item) => !dropped.has(item.id))
}

export function replaceById<T extends Identified>(list: readonly T[], updated: T): T[] {
  return list.map((item) => (item.id === updated.id ? updated : item))
}

export function mapValues<T, R>(
  record: Readonly<Record<string, T>>,
  transform: (value: T, key: string) => R,
): Record<string, R> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, transform(value, key)]),
  )
}

export function omitKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}

/** Counts occurrences of a derived key, used for the result summary tiles. */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const value = key(item)
    counts[value] = (counts[value] || 0) + 1
    return counts
  }, {})
}
