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
import { readTags } from './tags'
import type { FileEntry, Profile } from './types'

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
    hints: [
      'demos',
      'demo',
      'demoscene',
      'intro',
      'intros',
      'cracktros',
      'megademo',
      'megademos',
      'slideshow',
      'slideshows',
    ],
  },
  {
    id: 'magazines',
    name: 'Magazines',
    folderName: 'Mags',
    hints: [
      'magazines',
      'magazine',
      'mags',
      'diskmags',
      'diskmag',
      'coverdisks',
      'coverdisk',
      'coverdiscs',
      'coverdisc',
    ],
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
    hints: ['music', 'audio', 'mods', 'soundtracks', 'musicdisk', 'musicdisks'],
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

/** The canonical folder name for a category, or the bucket everything else shares. */
export function categoryFolder(categoryId: string | undefined): string {
  return categoryOf(categoryId)?.folderName || UNCATEGORISED
}

/**
 * The folder this profile writes a category to.
 *
 * A stick that already sorts itself has already answered this, and answering it
 * differently is how a destination ends up with both `Applications` and `Apps`:
 * the titles are written beside the ones already there rather than into them,
 * and every one of them reports as filed somewhere unexpected. So a folder
 * discovered on the destination beats the canonical name, and nothing beats a
 * name the user set for this profile by hand.
 */
export function categoryFolderFor(
  profile: Pick<Profile, 'categoryFolders'> | undefined,
  categoryId: string | undefined,
): string {
  const canonical = categoryFolder(categoryId)
  const known = categoryId ? profile?.categoryFolders?.[categoryId] : undefined
  return known?.trim() || canonical
}

// ---------------------------------------------------------------------------
// Reading a category out of a name
// ---------------------------------------------------------------------------

/**
 * The words of a piece of text, as one padded lower-case string.
 *
 * Matching against this is what makes every rule here whole-word: `Demolition`
 * never contains ` demo `, and `Gameshow` never contains ` game `. A wrong
 * category is silent and puts a title in the wrong folder on the drive, which
 * is far worse than leaving it unsorted where it can be seen and fixed.
 */
function wordsOf(text: string): string {
  return ` ${text.toLowerCase().split(/[^a-z0-9+]+/i).filter(Boolean).join(' ')} `
}

/**
 * The category a piece of free text names, if any.
 *
 * Deliberately reads *words* rather than whole labels, because collections name
 * their folders after their own catalogue: `Commodore Amiga - Games - [ADF]`,
 * `Acorn BBC Micro - Applications - [SSD]`, `Sinclair ZX Spectrum - Demos`.
 * Requiring the segment to *be* the word left every one of those unsorted, and
 * a whole TOSEC tree with it.
 */
export function categoryIn(text: string): string | undefined {
  const words = wordsOf(text)
  return categories.find((category) =>
    category.hints.some((hint) => words.includes(` ${wordsOf(hint).trim()} `)),
  )?.id
}

/**
 * Reads a category out of a title's own name.
 *
 * The folders a file sits in are the better evidence and are asked first, but a
 * downloaded title has none: it lands in a cache folder named after the site
 * and the download, which says nothing about what it holds. Its name often
 * does — "Amiga Format coverdisk", "SysInfo v4.4 utility".
 *
 * The name is read with its release tags taken off first, because in a
 * collection's naming convention a bracketed `(demo)` is a *development
 * status* — a playable demo of a commercial game — and not a demoscene
 * production at all. Filing every game demo under Demos is exactly the sort of
 * silent mistake that a few thousand titles turns into an afternoon's work.
 */
export function inferCategoryFromName(name: string): string | undefined {
  return categoryIn(readTags(name).bareTitle)
}

/**
 * What a title is, from whatever evidence there is: the folders it sits in
 * first, then its own name, then the name of the archive holding it.
 *
 * Nothing recognisable still means no category. An uncategorised title is
 * visible, filterable and easy to set in bulk; a wrongly categorised one is
 * silent, and ends up in the wrong folder on the drive.
 */
export function inferCategory(
  path: string,
  source: string,
  ...names: string[]
): string | undefined {
  const fromNames = names.length ? names : [path]
  return (
    inferCategoryId(path, source) ??
    fromNames.reduce<string | undefined>(
      (found, name) => found ?? inferCategoryFromName(name),
      undefined,
    )
  )
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
    .map((segment) => segment.trim())
    .filter(Boolean)

  for (const segment of [...segments].reverse()) {
    const match = categoryIn(segment)
    if (match) return match
  }
  return undefined
}

/**
 * The category folders a destination already uses, as it spells them.
 *
 * Read from the destination's own listing rather than assumed, so a stick that
 * calls its applications folder `Applications` keeps calling it that. Only a
 * folder that differs from the canonical name is recorded: an override that
 * says the same thing as the default is noise, and would have to be maintained
 * if the default ever changed.
 */
export function destinationCategoryFolders(
  entries: readonly FileEntry[],
): Record<string, string> {
  const found: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.directory) continue
    const id = categoryIn(entry.name)
    if (!id || id in found || entry.name === categoryFolder(id)) continue
    found[id] = entry.name
  }
  return found
}
