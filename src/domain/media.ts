/**
 * Classification, naming, and destination rules for library media.
 *
 * Nothing here touches the filesystem: these are pure functions over the
 * library model, which keeps them easy to reason about and to test.
 */

import { acceptedFormats, platforms, requireFirmware } from './catalog'
import { categoryFolder, inferCategoryId } from './categories'
import { dottedExtensionOf, joinRelative, safeFileName } from './paths'
import type { FileEntry, MediaItem, Profile, TransferOperation } from './types'

/** Tokens a custom folder template may use. */
export const FOLDER_TOKENS = ['platform', 'category', 'family', 'initial', 'format'] as const

/**
 * The alphabetical bucket a title belongs in.
 *
 * Digits share a single `0-9` folder and anything else shares `#`, which is the
 * convention every large retro collection uses — twenty-six letter folders plus
 * two catch-alls, rather than ten separate folders holding a handful of titles
 * between them.
 */
export function initialBucket(title: string): string {
  // The extension is dropped first, or a title of only punctuation would be
  // filed under the first letter of ".ssd".
  const stem = title.trim().replace(/\.[^.]+$/, '')
  const first = stem.match(/[a-z0-9]/i)?.[0]
  if (!first) return '#'
  return /[0-9]/.test(first) ? '0-9' : first.toUpperCase()
}

/**
 * Expands a custom folder template for one title.
 *
 * `{initial}` groups alphabetically, which is what makes a few thousand titles
 * navigable on a drive with a two-line display. Unknown tokens are left alone
 * rather than silently dropped, so a typo is visible in the preview instead of
 * quietly reshaping the whole layout.
 */
export function renderFolderTemplate(template: string, item: MediaItem): string {
  const platform = mediaPlatform(item)
  const title = item.canonicalTitle || item.name
  const values: Record<string, string> = {
    platform: platform?.folderName || 'Unsorted',
    category: categoryFolder(item.category),
    family: platform?.family || 'Unsorted',
    initial: initialBucket(title),
    format: item.extension.toUpperCase(),
  }
  const expanded = template.replace(/\{(\w+)\}/g, (whole, token: string) =>
    token in values ? values[token] : whole,
  )
  return joinRelative(
    ...expanded
      .split('/')
      .map((part) => safeFileName(part.trim()))
      .filter((part) => part && part !== 'Untitled'),
  )
}

/**
 * Recognises a file by extension.
 *
 * A format shared by several machines, such as `.dsk`, stays unassigned so the
 * user makes the choice explicitly rather than the application guessing.
 */
export function classifyMedia(entry: FileEntry, source: string): MediaItem {
  const extension = `.${entry.extension.toLowerCase()}`
  const likelyPlatformIds = platforms
    .filter((platform) => platform.formats.includes(extension))
    .map((platform) => platform.id)
  return {
    ...entry,
    id: entry.path,
    source,
    likelyPlatformIds,
    assignedPlatformId: likelyPlatformIds.length === 1 ? likelyPlatformIds[0] : undefined,
    canonicalTitle: entry.name,
    // A collection that files its own titles by kind has already answered this.
    category: inferCategoryId(entry.path, source),
  }
}

/** True when the item belongs to this platform, whether assigned or inferred. */
export function belongsToPlatform(item: MediaItem, platformId: string): boolean {
  return item.assignedPlatformId
    ? item.assignedPlatformId === platformId
    : item.likelyPlatformIds.includes(platformId)
}

/**
 * Reads an ambiguous title as belonging to the profile being prepared.
 *
 * A format such as `.ssd` or `.dsk` is claimed by several machines, so the
 * title stays unassigned until the user commits to one. Everything the profile
 * screen does with it — comparing against the destination, judging firmware
 * compatibility, working out where it would land — has to make the same
 * assumption, or the table reports one thing and the plan does another.
 */
export function forProfile(item: MediaItem, platformId: string): MediaItem {
  return item.assignedPlatformId ? item : { ...item, assignedPlatformId: platformId }
}

export function mediaPlatform(item: MediaItem) {
  return platforms.find((platform) => platform.id === item.assignedPlatformId)
}

/**
 * True when this drive can load this file directly.
 *
 * Both halves matter: the firmware family has to be usable on the machine, and
 * the format has to be one the pairing accepts. A `.atr` is a real Atari 8-bit
 * disk image, but an HxC drive still cannot load it without conversion.
 */
export function isFirmwareCompatible(item: MediaItem, firmwareId: string): boolean {
  const platform = mediaPlatform(item)
  if (!platform || !platform.firmwareIds.includes(firmwareId)) return false
  return acceptedFormats(platform.id, firmwareId).includes(`.${item.extension}`)
}

const UNITS = ['KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${UNITS[unit]}`
}

/**
 * Shortens a filename for a GoTek's small OLED display.
 *
 * Common release labels are dropped and the stem is truncated to the firmware's
 * display width. The extension is always preserved, and the library keeps the
 * canonical title so nothing is lost.
 */
export function oledName(name: string, length = 24): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  const title = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[_-]+/g, ' ')
    .replace(/\s*\([^)]*(demo|disk|side|rev|version)[^)]*\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${title.slice(0, Math.max(1, length - extension.length))}${extension}`
}

/**
 * A normalised key for comparing a local filename with a catalogue title.
 *
 * Deliberately conservative: it strips bracketed notes, leading articles, and
 * trailing disk numbers, which is enough for advisory "present" and "missing"
 * marks but is not a reliable identity.
 */
export function softwareTitleKey(value: string): string {
  const filename = value.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  const title = filename
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/,\s*the$/i, ' the')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return title.replace(/\b(disk|disc|side)\s*[a-z0-9]+$/i, '').trim()
}

/**
 * Turns the profile's collection into the copy operations the native planner
 * expects, applying the profile's own layout and naming rules.
 */
/**
 * The filename a title will be written under.
 *
 * An explicit alias always wins: the user typed it for this drive's display and
 * nothing should second-guess it. Otherwise OLED naming shortens the original.
 */
export function outputFileName(item: MediaItem, profile: Profile): string {
  const firmware = requireFirmware(profile.firmwareId)
  const extension = item.extension ? `.${item.extension}` : ''
  if (item.displayTitle?.trim()) {
    const alias = item.displayTitle.trim()
    return safeFileName(alias.toLowerCase().endsWith(extension) ? alias : `${alias}${extension}`)
  }
  return safeFileName(
    profile.naming === 'oled' ? oledName(item.name, firmware.oledLength) : item.name,
  )
}

/** The folder a title lands in, relative to the destination root. */
export function outputFolder(item: MediaItem, profile: Profile): string {
  if (!profile.organise) return ''
  if (profile.folderLayout === 'platform') return mediaPlatform(item)?.folderName || ''
  if (profile.folderLayout === 'category') return categoryFolder(item.category)
  if (profile.folderLayout === 'custom') {
    return renderFolderTemplate(profile.folderTemplate || '{platform}', item)
  }
  return ''
}

export function transferOperations(
  items: MediaItem[],
  profile: Profile,
): TransferOperation[] {
  return items.map((item) => ({
    source: item.path,
    relativePath: joinRelative(outputFolder(item, profile), outputFileName(item, profile)),
    size: item.size,
  }))
}

/**
 * The formats a profile is responsible for on its destination.
 *
 * This is the platform-and-firmware intersection rather than everything the
 * machine could theoretically use, which keeps the Remove policy as narrow as
 * possible: a file this drive cannot even load is not this profile's to delete.
 */
export function managedFormats(profile: Profile): string[] {
  return acceptedFormats(profile.platformId, profile.firmwareId)
}

/** True when a destination path holds a format this profile does not manage. */
export function isOutsideProfile(profile: Profile, path: string): boolean {
  return !managedFormats(profile).includes(dottedExtensionOf(path))
}
