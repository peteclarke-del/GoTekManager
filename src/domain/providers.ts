/**
 * Online providers.
 *
 * The list itself lives in `providers.json` beside this file, so it can be
 * changed without reading any code. That file is bundled at build time and
 * replaced at run time by a `providers.json` in the application's
 * configuration folder, whose path the settings screen shows.
 *
 * This module is only the rules: what a valid entry looks like, which entries
 * apply to a machine, and how a source's reach reads on screen.
 *
 * Each entry is a deliberate integration with a specific source. Adding one
 * means reviewing that site's terms and access policy first; the application
 * never performs generic scraping and never bypasses authentication, payment,
 * licensing, or `robots.txt` unless a source has been given the override by
 * hand.
 */

import bundled from './providers.json'
import type { OnlineProvider, ProviderAdapter } from './types'

const ADAPTERS: ProviderAdapter[] = ['internetArchive', 'htmlSite', 'jsonFeed']

/** What a provider file holds. */
export type ProviderConfig = {
  version: number
  providers: OnlineProvider[]
}

export type ProviderLoad = {
  providers: OnlineProvider[]
  /** Anything rejected, said plainly rather than dropped in silence. */
  problems: string[]
}

/**
 * Checks one entry from a file a person may have typed by hand.
 *
 * Returns the reason it is unusable rather than a boolean, because a config
 * file that is quietly half-ignored is worse than one that says what is wrong.
 */
function faultIn(entry: unknown, index: number, seen: Set<string>): string | null {
  const where = `entry ${index + 1}`
  if (typeof entry !== 'object' || entry === null) return `${where} is not an object`
  const provider = entry as Partial<OnlineProvider>

  if (!provider.id?.trim()) return `${where} has no id`
  if (seen.has(provider.id)) return `${where} repeats the id "${provider.id}"`
  if (!provider.name?.trim()) return `${provider.id} has no name`
  if (!provider.adapter || !ADAPTERS.includes(provider.adapter)) {
    return `${provider.id} has an unknown adapter "${provider.adapter}"`
  }
  if (provider.adapter === 'internetArchive') {
    if (!provider.query?.trim()) return `${provider.id} needs a query`
  } else if (!provider.catalogUrl?.startsWith('https://')) {
    // Enforced natively too; catching it here names the offending entry.
    return `${provider.id} needs an https:// URL`
  }
  return null
}

/** Validates a parsed provider file, keeping the entries that are usable. */
export function readProviderConfig(value: unknown): ProviderLoad {
  const problems: string[] = []
  const config = value as Partial<ProviderConfig> | null
  if (!config || !Array.isArray(config.providers)) {
    return { providers: [], problems: ['the file has no "providers" array'] }
  }

  const seen = new Set<string>()
  const providers: OnlineProvider[] = []
  config.providers.forEach((entry, index) => {
    const fault = faultIn(entry, index, seen)
    if (fault) {
      problems.push(fault)
      return
    }
    const provider = entry as OnlineProvider
    seen.add(provider.id)
    providers.push({ ...provider, builtIn: true })
  })
  return { providers, problems }
}

/** The list compiled into the application. */
export const defaultProviders: OnlineProvider[] = readProviderConfig(bundled).providers

/** Where a hand-written override is looked for. */
export const PROVIDERS_FILE = 'providers.json'

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
