/**
 * Path helpers that work for every kind of path the application handles.
 *
 * Three shapes reach this module and they must not be confused:
 *
 * - Native paths from the backend, which use `\` on Windows and `/` elsewhere.
 * - Destination-relative paths, which are always `/`-separated because the
 *   native planner rejects backslashes so one plan means the same thing on
 *   every platform.
 * - Virtual paths inside a FAT image, which are always `/`-separated and have
 *   an empty string as their root.
 */

const SEPARATORS = /[\\/]/
const TRAILING_SEPARATORS = /[\\/]+$/
const WINDOWS_DRIVE = /^[A-Za-z]:$/

/** Splits a native path on either separator, discarding empty segments. */
export function segments(path: string): string[] {
  return path.split(SEPARATORS).filter(Boolean)
}

/** The final segment of a native path, falling back to the path itself. */
export function basename(path: string): string {
  const parts = segments(path)
  return parts[parts.length - 1] || path
}

/** Lowercase extension without a leading dot, matching the backend. */
export function extensionOf(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Lowercase extension including the dot, for matching platform format lists. */
export function dottedExtensionOf(path: string): string {
  const extension = extensionOf(path)
  return extension ? `.${extension}` : ''
}

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * The containing folder of a native path.
 *
 * Returns the path unchanged once it reaches a root, so navigation cannot walk
 * past `/` or `C:\` into an empty string that no command could open.
 */
export function parentPath(path: string): string {
  const trimmed = path.replace(TRAILING_SEPARATORS, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return path
  if (index === 0) return trimmed.slice(0, 1)
  const parent = trimmed.slice(0, index)
  return WINDOWS_DRIVE.test(parent) ? `${parent}\\` : parent
}

/** The containing folder of a `/`-separated path inside a FAT image. */
export function imageParentPath(innerPath: string): string {
  const index = innerPath.lastIndexOf('/')
  return index < 0 ? '' : innerPath.slice(0, index)
}

/** True when there is somewhere above this path to navigate to. */
export function hasParent(path: string): boolean {
  const parent = parentPath(path)
  return parent !== path && parent.length < path.length
}

/**
 * Expresses `path` relative to `root`, normalised to `/` separators so it can
 * be sent to the native planner.
 */
export function relativeTo(root: string, path: string): string {
  const relative = path.startsWith(root) ? path.slice(root.length) : path
  return toPosix(relative).replace(/^\/+/, '')
}

/** Joins destination-relative segments with the canonical separator. */
export function joinRelative(...parts: string[]): string {
  return parts
    .map((part) => toPosix(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/**
 * Makes a filename safe on every supported filesystem, including FAT.
 *
 * Only the output name is changed. The library keeps the canonical title, so
 * nothing about the original file is lost.
 */
export function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_').trim() || 'Untitled'
}
