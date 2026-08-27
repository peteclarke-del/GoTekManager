/**
 * Online providers shipped with the application.
 *
 * Each entry is a deliberate integration with a specific source. Adding one
 * means reviewing that site's terms and access policy first; the application
 * never performs generic scraping and never bypasses authentication, payment,
 * licensing, or `robots.txt`.
 */

import type { OnlineProvider, ProviderAdapter } from './types'

export const defaultProviders: OnlineProvider[] = [
  {
    id: 'internet-archive',
    name: 'Internet Archive',
    adapter: 'internetArchive',
    query: 'mediatype:software',
    builtIn: true,
  },
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
]

const ADAPTER_LABELS: Record<ProviderAdapter, string> = {
  internetArchive: 'Search API',
  htmlSite: 'Website inspection',
  jsonFeed: 'JSON catalogue',
}

export function adapterLabel(adapter: ProviderAdapter): string {
  return ADAPTER_LABELS[adapter]
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
