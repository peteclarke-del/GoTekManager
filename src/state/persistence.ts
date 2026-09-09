/**
 * Local persistence.
 *
 * All state lives in `localStorage` today. This module is the only place that
 * knows that, so replacing it with a transactional database later means
 * changing these three functions rather than every screen.
 */

import { useEffect, useState } from 'react'

/** Reads and parses a stored value, falling back when absent or corrupt. */
export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    // A partially written or hand-edited value must never stop the app
    // starting; the default is always a usable state.
    return fallback
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be full or blocked. Losing a preference is not worth
    // interrupting the user's work.
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* see writeStored */
  }
}

/**
 * `useState` that loads from and saves to local storage.
 *
 * The initial value is computed lazily so a large library is parsed once, on
 * mount, rather than on every render.
 */
/**
 * State kept in local storage.
 *
 * What was stored is returned as it was written, which is right for a value
 * that is only ever whole. It is *not* right for a record that grows a field at
 * a time: a settings record written last month has none of this month's fields,
 * and handing it back untouched leaves them `undefined`, which reads as "off"
 * in a checkbox. A record of that kind needs `revive` to fill the gaps.
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  revive?: (stored: T) => T,
) {
  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initial === 'function' ? (initial as () => T)() : initial
    const stored = readStored(key, fallback)
    return stored === fallback ? fallback : (revive?.(stored) ?? stored)
  })
  useEffect(() => writeStored(key, value), [key, value])
  return [value, setValue] as const
}
