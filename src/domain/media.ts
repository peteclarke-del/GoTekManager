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
/**
 * Which disk of a set this is, and the title without it.
 *
 * A multi-disk game says so at the end of its name — `Elite (Disk 2)`,
 * `Another World ... A` — which is exactly where a trimmed name loses it. Two
 * disks that arrive at the same name are not a cosmetic problem: the write
 * refuses, because one would overwrite the other, and a set of four disks
 * becomes one file. So the marker is taken off before the title is cut and put
 * back afterwards, and it is the title that gives up room, never the disk.
 *
 * A number is written `D2` rather than `2`, which on a two-line display cannot
 * be mistaken for a year or a sequel.
 */
export function splitDiskMarker(stem: string): { title: string; marker: string } {
  const bracketed = stem.match(/[([]\s*(?:disk|disc|side)\s*([0-9]{1,2}|[a-z])\b[^)\]]*[)\]]/i)
  if (bracketed) {
    return {
      title: stem.replace(bracketed[0], ' '),
      marker: ` ${markerOf(bracketed[1])}`,
    }
  }
  const bare = stem.match(/\s(?:disk|disc|side)\s*([0-9]{1,2}|[a-z])\s*$/i)
  if (bare) {
    return { title: stem.slice(0, bare.index), marker: ` ${markerOf(bare[1])}` }
  }
  // A lone letter at the end is how most Amiga sets number their disks.
  const letter = stem.match(/\s([a-z])\s*$/i)
  if (letter) {
    return { title: stem.slice(0, letter.index), marker: ` ${letter[1].toUpperCase()}` }
  }
  return { title: stem, marker: '' }
}

function markerOf(value: string): string {
  return /^[0-9]+$/.test(value) ? `D${Number(value)}` : value.toUpperCase()
}

/**
 * A title with its middle taken out, for somewhere too narrow to show it all.
 *
 * What a retro title carries in the middle is almost always the publisher, and
 * what identifies it is at the two ends: the game at the front, which disk it
 * is at the back. Cutting the end therefore loses the useful half and leaves a
 * column of rows that read alike; cutting the middle keeps both.
 *
 * For display only. A name written to a drive keeps to plain characters and
 * drops the middle outright rather than marking it — see {@link oledName}.
 */
export function elideMiddle(text: string, max = 44): string {
  if (text.length <= max) return text
  // The tail is short and precious — "(Publisher) B.adf" — while the head is
  // what the eye reads first, so the head keeps most of the room.
  const tail = Math.min(14, Math.floor((max - 1) / 3))
  const head = Math.max(1, max - 1 - tail)
  return `${text.slice(0, head).trimEnd()}…${text.slice(text.length - tail).trimStart()}`
}

export function oledName(name: string, length = 24): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  const { title: stem, marker } = splitDiskMarker(
    (dot > 0 ? name.slice(0, dot) : name).replace(/[_-]+/g, ' '),
  )
  const title = stem
    // Release labels that say nothing about which file this is. `disk` is not
    // among them any more: which disk it is has already been taken out, and
    // anything left saying "disk" is part of the name.
    .replace(/\s*\([^)]*(demo|rev|version)[^)]*\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const room = Math.max(1, length - extension.length - marker.length)
  if (title.length <= room) return `${title}${marker}${extension}`

  // Still too long, so the middle goes before the ends do. What sits in
  // brackets is the publisher, the region, the dump — none of it says which
  // file this is, while the name at the front and the disk at the back both do.
  // Dropped outright rather than marked, because this becomes a filename on a
  // FAT volume read by an 8-bit drive, and an ellipsis is three bytes there.
  const withoutLabels = title.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim()
  if (withoutLabels && withoutLabels.length <= room) {
    return `${withoutLabels}${marker}${extension}`
  }
  const kept = withoutLabels || title
  return `${kept.slice(0, room).trimEnd()}${marker}${extension}`
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
