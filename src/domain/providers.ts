/**
 * Online providers shipped with the application.
 *
 * Each entry is a deliberate integration with a specific source. Adding one
 * means reviewing that site's terms and access policy first; the application
 * never performs generic scraping and never bypasses authentication, payment,
 * licensing, or `robots.txt`.
 *
 * That rule is why almost every default here is an Internet Archive collection:
 * it is a public, documented search API meant to be queried, rather than a
 * hobby site being crawled without being asked. Every collection identifier
 * below was checked against the live API rather than guessed, and the item
 * counts in the comments are what it returned.
 *
 * Two sites are known to refuse crawling outright and must not be added as
 * defaults: `spectrumcomputing.co.uk` and `bbcmicro.co.uk` both disallow all
 * user agents in `robots.txt`. The website adapter would refuse them at
 * runtime anyway; naming them here saves the next person the search.
 */

import type { OnlineProvider, ProviderAdapter } from './types'

/** Convenience for the many Internet Archive collections below. */
function archive(
  id: string,
  name: string,
  platformId: string,
  query: string,
): OnlineProvider {
  return { id, name, adapter: 'internetArchive', platformId, query, builtIn: true }
}

export const defaultProviders: OnlineProvider[] = [
  // Unscoped: searches any platform by name. Kept first because it is the one
  // source that applies whatever machine is being prepared.
  {
    id: 'internet-archive',
    name: 'Internet Archive',
    adapter: 'internetArchive',
    query: 'mediatype:software',
    builtIn: true,
  },

  // Acorn. The Internet Archive holds very little for these machines — around
  // thirty items between them — so Stairway to Hell, which is the long-standing
  // archive for both, does the work. Its robots.txt permits inspection.
  {
    id: 'stairway-bbc',
    name: 'Stairway to Hell: BBC',
    adapter: 'htmlSite',
    catalogUrl: 'https://www.stairwaytohell.com/bbc/homepage.html',
    platformId: 'bbc',
    builtIn: true,
  },
  {
    id: 'stairway-electron',
    name: 'Stairway to Hell: Electron',
    adapter: 'htmlSite',
    catalogUrl: 'https://www.stairwaytohell.com/electron/homepage.html',
    platformId: 'electron',
    builtIn: true,
  },

  // Amstrad: Software Library: Amstrad CPC, 3,809 items.
  archive('ia-cpc464', 'Internet Archive: Amstrad CPC', 'cpc464', 'collection:softwarelibrary_cpc'),
  archive('ia-cpc6128', 'Internet Archive: Amstrad CPC', 'cpc6128', 'collection:softwarelibrary_cpc'),

  // Commodore: Software Library: C64, 98,846 items. Only a sample is fetched.
  archive('ia-c64', 'Internet Archive: Commodore 64', 'c64', 'collection:softwarelibrary_c64'),
  // The 128 and the Plus/4 have no collection of their own, so these are
  // subject searches and return tens of items rather than thousands.
  archive(
    'ia-c128',
    'Internet Archive: Commodore 128',
    'c128',
    'mediatype:software AND (subject:"commodore 128" OR title:"C128")',
  ),
  archive(
    'ia-plus4',
    'Internet Archive: Commodore Plus/4',
    'plus4',
    'mediatype:software AND (subject:"plus/4" OR title:"Plus/4" OR subject:"commodore plus4")',
  ),
  // Software Library: Amiga, 13,207 items.
  archive('ia-amiga', 'Internet Archive: Amiga', 'amiga', 'collection:softwarelibrary_amiga'),

  // Sinclair: Software Library: ZX Spectrum, 12,305 items. The same collection
  // serves both machines; a 48K title runs on a 128K.
  archive(
    'ia-spectrum48',
    'Internet Archive: ZX Spectrum',
    'spectrum48',
    'collection:softwarelibrary_zx_spectrum',
  ),
  archive(
    'ia-spectrum128',
    'Internet Archive: ZX Spectrum',
    'spectrum128',
    'collection:softwarelibrary_zx_spectrum',
  ),
  // Nothing for the Next: it is recent enough that its software lives on
  // itch.io and the official distribution, neither of which can be indexed
  // without an authenticated integration.

  // Atari: 4,729 games for the 8-bit line, 884 for the ST.
  archive(
    'ia-atari-8bit',
    'Internet Archive: Atari 8-bit',
    'atari-8bit',
    'collection:atari_8bit_library_games',
  ),
  archive(
    'ia-atari-st',
    'Internet Archive: Atari ST',
    'atari-st',
    'collection:softwarelibrary_atari_st_games',
  ),
]

const ADAPTER_LABELS: Record<ProviderAdapter, string> = {
  internetArchive: 'Search API',
  htmlSite: 'Website inspection',
  jsonFeed: 'JSON catalogue',
}

export function adapterLabel(adapter: ProviderAdapter): string {
  return ADAPTER_LABELS[adapter]
}

/**
 * The providers worth showing for a platform.
 *
 * A source without a `platformId` covers everything; one with it is specific to
 * that machine. Showing a BBC Micro archive while preparing an Amstrad stick is
 * just noise, and worse, refreshing it would cache a catalogue of titles that
 * can never apply.
 */
export function providersFor(
  providers: OnlineProvider[],
  platformId: string,
): OnlineProvider[] {
  return providers.filter(
    (provider) => !provider.platformId || provider.platformId === platformId,
  )
}

/** How a source's reach reads in the sidebar. */
export function scopeLabel(
  provider: OnlineProvider,
  platformName: (id: string) => string,
): string {
  return provider.platformId ? `${platformName(provider.platformId)} only` : 'All platforms'
}

/** Only the Internet Archive exposes multiple files inside one entry. */
export function isBrowsable(provider: OnlineProvider | undefined): boolean {
  return provider?.adapter === 'internetArchive'
}

/**
 * A title can be fetched when the Archive can resolve it, or when the
 * catalogue supplied a direct URL. Reference-only lists have neither and are
 * used purely for coverage comparison.
 */
export function isDownloadable(
  provider: OnlineProvider | undefined,
  title: { downloadUrl?: string },
): boolean {
  return isBrowsable(provider) || Boolean(title.downloadUrl)
}
