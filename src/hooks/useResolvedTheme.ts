/**
 * Resolves the theme setting to the palette actually on screen.
 *
 * "System" follows the operating system, so anything that has to match the
 * current appearance — the help screenshots, for instance — needs the resolved
 * answer rather than the stored preference, and needs to update when the
 * system preference changes while the window is open.
 */

import { useEffect, useState } from 'react'
import type { ThemeChoice } from '../domain/types'

const DARK = '(prefers-color-scheme: dark)'

function prefersDark(): boolean {
  // Guarded so the module is safe to import in a non-browser context.
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(DARK).matches
}

export function useResolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(prefersDark)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia(DARK)
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return choice === 'system' ? (systemDark ? 'dark' : 'light') : choice
}
