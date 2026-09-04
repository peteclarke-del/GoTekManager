/**
 * What a title *is*, as opposed to which machine it runs on.
 *
 * A few thousand titles on one stick is unusable on a two-line display, and
 * platform folders only help when a stick holds more than one machine. Splitting
 * games from applications, demos and magazines is what makes a large collection
 * navigable, so a category is something a title carries and a profile's layout
 * can be built from.
 *
 * The list is deliberately short. Every extra category is another decision at
 * indexing time and another folder to scroll past on the drive, and the
 * distinctions that matter to someone standing at a real machine are coarse.
 */

import { toPosix } from './paths'

export type Category = {
  id: string
  name: string
  /** Short folder name written to the drive, kept OLED-friendly. */
  folderName: string
  /**
   * Words that name this category in a collection's own folder tree, lower
   * case. Organised collections say what they hold — TOSEC, for one, files
   * under `Applications`, `Games`, `Demos` and `Magazines` — so a library that
   * is already sorted does not have to be sorted again by hand.
   */
  hints: string[]
}

export const categories: Category[] = [
  {
    id: 'games',
    name: 'Games',
    folderName: 'Games',
    hints: ['games', 'game', 'gaming'],
  },
  {
    id: 'applications',
    name: 'Applications',
    folderName: 'Apps',
    hints: ['applications', 'application', 'apps', 'productivity', 'business'],
  },
  {
    id: 'demos',
    name: 'Demos',
    folderName: 'Demos',
    hints: ['demos', 'demo', 'demoscene', 'intros', 'cracktros'],
  },
  {
    id: 'magazines',
    name: 'Magazines',
    folderName: 'Mags',
    hints: ['magazines', 'magazine', 'mags', 'diskmags', 'diskmag', 'coverdisks', 'coverdisk'],
  },
  {
    id: 'utilities',
    name: 'Utilities',
    folderName: 'Utils',
    hints: ['utilities', 'utility', 'utils', 'tools', 'tool'],
  },
  {
    id: 'music',
    name: 'Music',
    folderName: 'Music',
    hints: ['music', 'audio', 'mods', 'soundtracks'],
  },
  {
    id: 'education',
    name: 'Education',
    folderName: 'Edu',
    hints: ['education', 'educational', 'edu', 'schools'],
  },
  {
    id: 'system',
    name: 'System and firmware',
    folderName: 'System',
    hints: ['system', 'firmware', 'operating systems', 'os', 'workbench', 'kickstart', 'boot'],
  },
]

/** The folder an uncategorised title is written to under a category layout. */
export const UNCATEGORISED = 'Unsorted'

function categoryOf(categoryId: string | undefined): Category | undefined {
  return categoryId ? categories.find((category) => category.id === categoryId) : undefined
}

/** The folder name for a category, or the bucket everything else shares. */
export function categoryFolder(categoryId: string | undefined): string {
  return categoryOf(categoryId)?.folderName || UNCATEGORISED
}

/**
 * Reads a category out of a title's own name.
 *
 * The folders a file sits in are the better evidence and are asked first, but a
 * downloaded title has none: it lands in a cache folder named after the site
 * and the download, which says nothing about what it holds. Its name often
 * does — "Zool 1 (Gremlin) demo", "Amiga Format coverdisk", "SysInfo v4.4".
 *
 * Only whole words count, so "Demolition" is not a demo and "Gameshow" is not
 * filed under games by accident.
 */
export function inferCategoryFromName(name: string): string | undefined {
  const words = new Set(
    name
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .split(/[^a-z0-9+]+/)
      .filter(Boolean),
  )
  return categories.find((category) => category.hints.some((hint) => words.has(hint)))?.id
}

/**
 * What a title is, from whatever evidence there is: the folders it sits in
 * first, then its own name.
 *
 * Nothing recognisable still means no category. An uncategorised title is
 * visible, filterable and easy to set in bulk; a wrongly categorised one is
 * silent, and ends up in the wrong folder on the drive.
 */
export function inferCategory(path: string, source: string, name?: string): string | undefined {
  return inferCategoryId(path, source) ?? inferCategoryFromName(name ?? path)
}

/**
 * Reads a category out of the folders a file sits in.
 *
 * Only whole path segments are matched, and only the ones between the source
 * root and the file: a library called `Games` would otherwise make every title
 * under it a game, including the magazines. The deepest match wins, because a
 * collection nests from general to specific — `Commodore/Amiga/Applications`
 * ends with what the folder actually holds.
 *
 * Nothing recognisable means no category rather than a guess: an uncategorised
 * title is visible and easy to set, while a wrong one is silent.
 */
export function inferCategoryId(path: string, source: string): string | undefined {
  const relative = toPosix(path).slice(toPosix(source).length)
  const segments = relative
    .split('/')
    .slice(0, -1)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)

  for (const segment of [...segments].reverse()) {
    // A TOSEC-style folder carries a qualifier, as in "Games [ADF]", so the
    // bracketed part is dropped before the segment is read as a name.
    const name = segment.replace(/[[(].*$/, '').trim()
    const match = categories.find((category) => category.hints.includes(name))
    if (match) return match.id
  }
  return undefined
}
