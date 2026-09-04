/**
 * Comparing the version in front of the user with what has been published.
 *
 * Kept apart from the asking so it can be checked without a network: version
 * ordering looks obvious and is quietly wrong the first time a project reaches
 * `0.10.0`, where a string comparison puts it before `0.9.0` and nobody is ever
 * told about the release.
 */

import type { PublishedRelease } from './types'

/**
 * The numbers in a version string, for comparing one against another.
 *
 * Tags in the wild carry a `v`, a suffix, or both: `v0.2.0`, `0.2.0` and
 * `0.2.0-rc1` are all `[0, 2, 0]`. A tag with no numbers in it sorts as nothing
 * at all, which is what stops a stray tag being read as a release.
 */
export function parseVersion(text: string): number[] {
  return (text.match(/\d+/g) ?? []).slice(0, 4).map(Number)
}

/** Whether `candidate` is a later version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const theirs = parseVersion(candidate)
  const ours = parseVersion(current)
  if (!theirs.length) return false
  // Padded, so 0.2 and 0.2.0 compare equal rather than by how many parts they
  // were written with.
  const width = Math.max(theirs.length, ours.length)
  for (let index = 0; index < width; index += 1) {
    const mine = ours[index] ?? 0
    const other = theirs[index] ?? 0
    if (other !== mine) return other > mine
  }
  return false
}

/**
 * The newest published release that is later than the running version.
 *
 * Drafts and prereleases are not offered: a draft is not published at all, and
 * a prerelease is something someone has to go looking for rather than be sent
 * to. The newest is chosen by version rather than by the order the API happened
 * to return, so a repository whose releases are out of order still answers
 * correctly.
 */
export function newerRelease(
  releases: PublishedRelease[],
  current: string,
): PublishedRelease | undefined {
  return releases
    .filter((release) => !release.draft && !release.prerelease)
    .filter((release) => isNewer(release.tag, current))
    .sort((left, right) => (isNewer(right.tag, left.tag) ? 1 : -1))[0]
}
