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

import { platforms } from './catalog'
import bundled from './providers.json'
import { upsertById } from './records'
import type { OnlineProvider, ProviderAdapter } from './types'

const ADAPTERS: ProviderAdapter[] = ['internetArchive', 'htmlSite', 'jsonFeed', 'demozoo']

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
 * Checks one source, wherever it came from.
 *
 * Returns the reason it is unusable rather than a boolean, because a config
 * file that is quietly half-ignored is worse than one that says what is wrong,
 * and because the same sentence is what the edit dialog should show. `where`
 * names the entry in that sentence; `seen` is only supplied when reading a
 * file, where a repeated id is a fault the editor cannot produce.
 */
export function faultIn(
  entry: unknown,
  where: string,
  seen: Set<string> = new Set(),
): string | null {
  if (typeof entry !== 'object' || entry === null) return `${where} is not an object`
  const provider = entry as Partial<OnlineProvider>

  if (!provider.id?.trim()) return `${where} has no id`
  if (seen.has(provider.id)) return `${where} repeats the id "${provider.id}"`
  if (!provider.name?.trim()) return `${where} has no name`
  if (!provider.adapter || !ADAPTERS.includes(provider.adapter)) {
    return `${where} has an unknown adapter "${provider.adapter}"`
  }
  // Every source belongs to one machine. A source that named none used to be
  // shown while preparing any of them, which put an Amstrad archive in front of
  // someone writing a BBC stick and cached its titles as if they were Acorn's.
  if (!provider.platformId?.trim()) {
    return `${where} does not say which machine it is for`
  }
  if (!platforms.some((platform) => platform.id === provider.platformId)) {
    return `${where} names an unknown machine "${provider.platformId}"`
  }
  if (provider.adapter === 'demozoo') {
    // The query carries the Demozoo platform number; anything else would be
    // sent as a filter and quietly return another machine's productions.
    if (!/^\d+$/.test(provider.query?.trim() || '')) {
      return `${where} needs a Demozoo platform number in its query`
    }
  } else if (provider.adapter === 'internetArchive') {
    if (!provider.query?.trim()) return `${where} needs a query`
  } else if (!provider.catalogUrl?.startsWith('https://')) {
    // Enforced natively too; catching it here names the offending entry.
    return `${where} needs an https:// URL`
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
    const fault = faultIn(entry, `entry ${index + 1}`, seen)
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

/**
 * The user's own sources, held to the same standard as the ones that ship.
 *
 * A source saved before every source had to name a machine would otherwise
 * simply stop appearing, with nothing said. Naming it means the user can open
 * its settings, choose the machine, and have it back.
 */
export function readCustomProviders(entries: readonly OnlineProvider[]): ProviderLoad {
  const problems: string[] = []
  const providers: OnlineProvider[] = []
  for (const entry of entries) {
    const fault = faultIn(entry, `the source "${entry?.name || entry?.id || 'you added'}"`)
    if (fault) problems.push(fault)
    else providers.push(entry)
  }
  return { providers, problems }
}

/**
 * The list the interface works with.
 *
 * A source the user changed is kept as an entry with the same id rather than as
 * a copy of the whole file, so the built-in list stays the thing that is
 * shipped and an edit stays something that can be undone. Which of the three an
 * entry is — shipped, shipped-and-changed, or the user's own — is recorded on
 * it here so that no screen has to work it out again from two lists.
 */
export function mergeProviders(
  shipped: OnlineProvider[],
  custom: OnlineProvider[],
): OnlineProvider[] {
  const shippedIds = new Set(shipped.map((provider) => provider.id))
  return upsertById(
    shipped,
    ...custom.map((provider) => ({
      ...provider,
      builtIn: shippedIds.has(provider.id),
      overridden: shippedIds.has(provider.id),
    })),
  )
}

/** The list compiled into the application. */
export const defaultProviders: OnlineProvider[] = readProviderConfig(bundled).providers

/** Where a hand-written override is looked for. */
export const PROVIDERS_FILE = 'providers.json'

const ADAPTER_LABELS: Record<ProviderAdapter, string> = {
  internetArchive: 'Search API',
  htmlSite: 'Website inspection',
  jsonFeed: 'JSON catalogue',
  demozoo: 'Demozoo API',
}

export function adapterLabel(adapter: ProviderAdapter): string {
  return ADAPTER_LABELS[adapter]
}

/**
 * The providers worth showing for a platform.
 *
 * Every source names one machine, and only that machine's sources are shown.
 * Anything else is noise at best: showing a BBC Micro archive while preparing
 * an Amstrad stick wastes the reader's attention, and refreshing it would cache
 * a catalogue of titles that can never apply to what is being written.
 */
export function providersFor(
  providers: OnlineProvider[],
  platformId: string,
): OnlineProvider[] {
  return providers.filter((provider) => provider.platformId === platformId)
}

/**
 * Which sources hold several files behind one entry.
 *
 * Both of these are APIs whose listing gives titles and whose per-item resource
 * gives the files, so a title is opened to see what is inside it.
 */
export function isBrowsable(provider: OnlineProvider | undefined): boolean {
  return provider?.adapter === 'internetArchive' || provider?.adapter === 'demozoo'
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
