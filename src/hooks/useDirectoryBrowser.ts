/**
 * Browsing a profile's destination, whether it is a folder, a mounted volume,
 * or a read-only FAT image.
 *
 * The two screens that browse a destination previously carried near-identical
 * copies of this logic, including their own bugs about where "up" stops.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { hasParent, imageParentPath, parentPath } from '../domain/paths'
import type { FileEntry, Profile } from '../domain/types'
import { errorMessage, listDirectory, listImageDirectory } from '../native/commands'

export type DirectoryBrowser = {
  /** Native path, or a `/`-separated path inside the image. */
  path: string
  entries: FileEntry[]
  error: string
  busy: boolean
  isImage: boolean
  canGoUp: boolean
  open: (path: string) => Promise<void>
  goUp: () => Promise<void>
  refresh: () => Promise<void>
}

export function useDirectoryBrowser(
  profile: Profile | undefined,
  /** When true, navigation cannot go above the destination root. */
  confineToRoot = true,
): DirectoryBrowser {
  const isImage = profile?.destination.kind === 'image'
  const root = isImage ? '' : profile?.destination.path || ''
  const [path, setPath] = useState(root)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Only the newest request may write to state; React's strict mode and rapid
  // clicking both produce overlapping loads.
  const request = useRef(0)

  const open = useCallback(
    async (next: string) => {
      if (!profile) return
      const ticket = (request.current += 1)
      setBusy(true)
      setError('')
      try {
        const listing = isImage
          ? await listImageDirectory(profile.destination.path, next)
          : await listDirectory(next)
        if (ticket !== request.current) return
        setEntries(listing)
        setPath(next)
      } catch (reason) {
        if (ticket !== request.current) return
        setEntries([])
        setError(errorMessage(reason))
        setPath(next)
      } finally {
        if (ticket === request.current) setBusy(false)
      }
    },
    [isImage, profile?.destination.path, profile?.id],
  )

  useEffect(() => {
    if (profile) void open(root)
    // Re-opening the root is exactly what should happen when the profile
    // changes, so the browser never shows another destination's contents.
  }, [profile?.id, root, open])

  const parent = isImage ? imageParentPath(path) : parentPath(path)
  const canGoUp = isImage
    ? path !== ''
    : confineToRoot
      ? path !== root && path.length > root.length
      : hasParent(path)

  const goUp = useCallback(() => open(parent), [open, parent])
  const refresh = useCallback(() => open(path), [open, path])

  return { path, entries, error, busy, isImage, canGoUp, open, goUp, refresh }
}
