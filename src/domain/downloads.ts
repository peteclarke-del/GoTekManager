/**
 * Where downloaded titles belong in the library.
 *
 * A download is cached in a folder of its own, one per title, so that a second
 * attempt can reuse it. Registering each of those folders as a source made the
 * list of local sources into a list of downloads: sixty-six entries reading
 * "1 title" apiece, filling the sidebar meant for the folders somebody actually
 * chose.
 *
 * They belong together, under the site they came from. Everything cached from
 * one source sits under one folder — `.../downloads/<site>/<title>/…` — so that
 * folder is the source, and the per-title folders below it are its contents.
 */

import { upsertById } from './records'
import type { MediaItem, SourceLocation } from './types'

/** The part of a cache path that says a download is what follows. */
const DOWNLOADS = '/online-library/downloads/'

/**
 * The site folder a cached download belongs to, or nothing when the path is not
 * a download at all.
 */
export function downloadSourceOf(path: string): string | undefined {
  const at = path.indexOf(DOWNLOADS)
  if (at < 0) return undefined
  const after = at + DOWNLOADS.length
  const end = path.indexOf('/', after)
  const site = end < 0 ? path.slice(after) : path.slice(after, end)
  return site ? `${path.slice(0, after)}${site}` : undefined
}

/**
 * A library with its downloads gathered under one source per site.
 *
 * Applied when the library is read, so a collection built up before downloads
 * were grouped tidies itself up rather than leaving the user to remove dozens
 * of entries by hand. It only ever moves a title from one source to another;
 * nothing is dropped, and a title's own path is untouched.
 */
export function groupDownloads(
  sources: SourceLocation[],
  items: MediaItem[],
): { sources: SourceLocation[]; items: MediaItem[] } {
  const moved = new Map<string, string>()
  const grouped: SourceLocation[] = []

  for (const source of sources) {
    const site = downloadSourceOf(source.path)
    if (!site || site === source.path) {
      grouped.push(source)
      continue
    }
    moved.set(source.path, site)
    // The first one to arrive names the site, minus the wording that made
    // sense when a source was a single download.
    if (!grouped.some((entry) => entry.path === site)) {
      grouped.push({
        id: `source:${site}`,
        name: source.name.replace(/\s*cache$/i, '').trim() || source.name,
        path: site,
      })
    }
  }

  if (!moved.size) return { sources, items }
  return {
    sources: upsertById(grouped),
    items: items.map((item) => {
      const site = moved.get(item.source)
      return site ? { ...item, source: site } : item
    }),
  }
}
