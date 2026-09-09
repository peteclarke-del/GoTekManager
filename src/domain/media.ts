/**
 * Classification, naming, and destination rules for library media.
 *
 * Nothing here touches the filesystem: these are pure functions over the
 * library model, which keeps them easy to reason about and to test.
 */

import { acceptedFormats, platforms, requireFirmware } from './catalog'
import { categoryFolderFor, inferCategoryFor } from './categories'
import { archiveOf, basename, dottedExtensionOf, joinRelative, safeFileName } from './paths'
import { extensionPart, readTags, type ReleaseTags } from './tags'
import type {
  FileEntry,
  MediaItem,
  NamingRule,
  Profile,
  TransferOperation,
} from './types'

/** Tokens a custom folder template may use. */
export const FOLDER_TOKENS = ['platform', 'category', 'family', 'initial', 'format'] as const

/**
 * What a file is called once it reaches the drive.
 *
 * Two separate questions used to be conflated in one setting: whether to keep
 * everything the collection recorded about a release, and whether the name has
 * to fit a small display. They are split here, so a stick prepared for a drive
 * with no panel at all still gets titles rather than catalogue entries.
 */
export const NAMING_CHOICES: Array<{
  id: NamingRule
  name: string
  /** The same thing named inside a sentence, lower case. */
  short: string
  summary: string
}> = [
  {
    id: 'title',
    name: 'Title only',
    short: 'title only',
    summary:
      'The name of the game or application, and which disc it is when the set has more than one. Year, publisher, region, language and dump flags are all left behind.',
  },
  {
    id: 'oled',
    name: 'Title, shortened for the display',
    short: 'shortened title',
    summary:
      "The same name, cut to what the drive's panel can show. The disc is never what gives up room.",
  },
  {
    id: 'original',
    name: 'Original filename',
    short: 'original',
    summary: 'Exactly what the collection called the file, tags and all.',
  },
]

/** The naming rule in full, for a control that has room to explain itself. */
export function namingChoice(naming: NamingRule) {
  return NAMING_CHOICES.find((choice) => choice.id === naming) ?? NAMING_CHOICES[0]
}

/** The naming rule named inside a sentence. */
export function namingLabel(naming: NamingRule): string {
  return namingChoice(naming).short
}

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
export function renderFolderTemplate(
  template: string,
  item: MediaItem,
  profile?: Pick<Profile, 'categoryFolders'>,
): string {
  const platform = mediaPlatform(item)
  const title = item.canonicalTitle || item.name
  const values: Record<string, string> = {
    platform: platform?.folderName || 'Unsorted',
    category: categoryFolderFor(profile, item.category),
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
 * Every name that describes one title: its own, and its archive's.
 *
 * A title held in a ZIP has two names and the tags are rarely on the one
 * inside — a single-title archive is `Dungeon Master (1987)(FTL).zip` holding
 * `disk1.adf`. Reading both is what stops such a title arriving with no year,
 * no publisher and no idea which disc it is.
 */
export function namesOf(item: Pick<MediaItem, 'name' | 'path'>): string[] {
  const archive = archiveOf(item.path)
  return archive ? [item.name, basename(archive)] : [item.name]
}

/**
 * The release tags for one title, read once.
 *
 * Reading tags is regular-expression work over every name in the library, and
 * the bulk-add preview asks for them again on every change to a filter. The
 * answer only depends on the names, so it is remembered against them; the cache
 * is dropped wholesale rather than grown without limit, because a library that
 * large has already been read once by then.
 */
const TAG_CACHE = new Map<string, ReleaseTags>()
const TAG_CACHE_LIMIT = 200000

export function tagsOf(item: Pick<MediaItem, 'name' | 'path'>): ReleaseTags {
  const key = `${item.path}\u0000${item.name}`
  const known = TAG_CACHE.get(key)
  if (known) return known
  const tags = readTags(...namesOf(item))
  if (TAG_CACHE.size >= TAG_CACHE_LIMIT) TAG_CACHE.clear()
  TAG_CACHE.set(key, tags)
  return tags
}

/**
 * Recognises a file by extension.
 *
 * A format shared by several machines, such as `.dsk`, stays unassigned so the
 * user makes the choice explicitly rather than the application guessing.
 */
export function classifyMedia(
  entry: FileEntry,
  source: string,
  /** What the user called this source, which is often what says what is in it. */
  sourceName?: string,
): MediaItem {
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
    // A collection that files its own titles by kind has already answered
    // this; a download has no such folders, so its name is asked instead — and
    // for a title inside an archive, the archive's name is a name too.
    category: inferCategoryFor(entry.path, { path: source, name: sourceName }, ...namesOf(entry)),
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
 * A title with its middle taken out, for somewhere too narrow to show it all.
 *
 * What a retro title carries in the middle is almost always the publisher, and
 * what identifies it is at the two ends: the game at the front, which disk it
 * is at the back. Cutting the end therefore loses the useful half and leaves a
 * column of rows that read alike; cutting the middle keeps both.
 *
 * For display only. A name written to a drive has already had the publisher
 * taken off by {@link releaseName}, so there is no middle left to lose.
 */
export function elideMiddle(text: string, max = 44): string {
  if (text.length <= max) return text
  // The tail is short and precious — "(Publisher) B.adf" — while the head is
  // what the eye reads first, so the head keeps most of the room.
  const tail = Math.min(14, Math.floor((max - 1) / 3))
  const head = Math.max(1, max - 1 - tail)
  return `${text.slice(0, head).trimEnd()}…${text.slice(text.length - tail).trimStart()}`
}

/**
 * A normalised key for comparing one title with another.
 *
 * Built on the same reading of the name as everything else, so a library title
 * and a catalogue entry are compared on what the software *is* rather than on
 * how one collection chose to label it. Deliberately conservative: it is enough
 * for grouping a disc set and for advisory "present" and "missing" marks, and
 * it is not a reliable identity.
 */
export function softwareTitleKey(value: string): string {
  return normaliseTitle(readTags(basename(value)).bareTitle)
}

/**
 * A title reduced to the letters and digits that identify it.
 *
 * Kept apart from {@link softwareTitleKey} so a title that has already been
 * read out of a filename is not parsed a second time to be compared.
 */
export function normaliseTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/,\s*the$/i, ' the')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Disc sets
// ---------------------------------------------------------------------------

/**
 * How many discs this title's set holds, and which one this is.
 *
 * Whether a disc marker is needed at all is a fact about the *set*, never about
 * the file: a one-disc game is `Elite.adf`, and only a set of several needs to
 * say which is which. That is why naming takes this alongside the title.
 */
export type SetPosition = { size: number; label?: string }

/** The default for a title nothing has told us about: one disc, no marker. */
export const SINGLE_DISC: SetPosition = { size: 1 }

/**
 * What makes two files discs of the same thing: the same software on the same
 * machine. The disc marker is deliberately not part of it — that is what
 * distinguishes members *within* a set.
 */
export function setKeyOf(item: MediaItem): string {
  return `${normaliseTitle(tagsOf(item).bareTitle)}\u0000${item.assignedPlatformId ?? ''}`
}

/**
 * Groups titles into the sets they belong to.
 *
 * The size of a set is whichever is larger: how many discs the collection says
 * there are — `(Disk 1 of 3)` says three even when only two were ever found —
 * and how many distinct discs are actually here. Taking the larger of the two
 * is what lets an incomplete set be recognised as incomplete rather than
 * quietly renumbered.
 */
export function setIndexOf(items: readonly MediaItem[]): Map<string, SetPosition> {
  const groups = new Map<string, MediaItem[]>()
  for (const item of items) {
    const key = setKeyOf(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }

  const positions = new Map<string, SetPosition>()
  for (const group of groups.values()) {
    const labels = new Set<string>()
    let stated = 0
    for (const item of group) {
      const disk = tagsOf(item).disk
      if (!disk) continue
      labels.add(disk.label)
      if (disk.of) stated = Math.max(stated, disk.of)
    }
    const size = Math.max(stated, labels.size, 1)
    for (const item of group) {
      positions.set(item.id, { size, label: tagsOf(item).disk?.label })
    }
  }
  return positions
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * The name a title is written under: what it is, and which disc, and nothing
 * else.
 *
 * `Dungeon Master (1987)(FTL)(GB)(Disk 1 of 2)[cr QTX].adf` becomes
 * `Dungeon Master D1.adf`. The year, the publisher, the region, the language,
 * the version and the dump flags are all things about *this copy* of the
 * software; none of them helps somebody standing at a real machine reading a
 * two-line display, and several of them are longer than the title.
 *
 * The disc marker only appears when the set actually has more than one disc,
 * and when the name has to be cut to fit a panel it is the title that gives up
 * room, never the disc — two discs arriving at one name is not a cosmetic
 * problem, it is a write that refuses because one would overwrite the other.
 */
export function releaseName(
  item: MediaItem,
  set: SetPosition = SINGLE_DISC,
  length?: number,
  suffix = '',
): string {
  const tags = tagsOf(item)
  const extension = extensionPart(item.name)
  const marker = set.size > 1 && set.label ? ` ${set.label}` : ''
  // A name that was nothing but tags still has to be called something, and the
  // filename it arrived under is the only thing left to call it.
  const stem = tags.bareTitle || item.name.slice(0, item.name.length - extension.length)
  const tail = `${marker}${suffix}${extension}`
  if (length === undefined) return safeFileName(`${stem}${tail}`)
  const room = Math.max(1, length - tail.length)
  return safeFileName(`${stem.length <= room ? stem : stem.slice(0, room).trimEnd()}${tail}`)
}

/** Puts a disambiguating suffix before the extension of an untouched name. */
function withSuffix(name: string, suffix: string): string {
  if (!suffix) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`
}

/**
 * The filename a title will be written under.
 *
 * An explicit alias always wins: the user typed it for this drive's display and
 * nothing should second-guess it. Otherwise the profile's rule decides whether
 * the collection's own name is kept, reduced to the title, or reduced and cut
 * to the panel's width.
 */
export function outputFileName(
  item: MediaItem,
  profile: Profile,
  set: SetPosition = SINGLE_DISC,
  suffix = '',
): string {
  const extension = extensionPart(item.name)
  if (item.displayTitle?.trim()) {
    const alias = item.displayTitle.trim()
    return safeFileName(
      withSuffix(
        alias.toLowerCase().endsWith(extension.toLowerCase()) ? alias : `${alias}${extension}`,
        suffix,
      ),
    )
  }
  if (profile.naming === 'original') return safeFileName(withSuffix(item.name, suffix))
  const length =
    profile.naming === 'oled' ? requireFirmware(profile.firmwareId).oledLength : undefined
  return releaseName(item, set, length, suffix)
}

/** The folder a title lands in, relative to the destination root. */
export function outputFolder(item: MediaItem, profile: Profile): string {
  if (!profile.organise) return ''
  if (profile.folderLayout === 'platform') return mediaPlatform(item)?.folderName || ''
  if (profile.folderLayout === 'category') return categoryFolderFor(profile, item.category)
  if (profile.folderLayout === 'custom') {
    return renderFolderTemplate(profile.folderTemplate || '{platform}', item, profile)
  }
  return ''
}

/**
 * What can be added to two identical names to tell them apart, best first.
 *
 * Reducing a name to its title is exactly what makes two files collide:
 * `Elite (1984)` and `Elite (1987)[a]` are both `Elite.adf`. Where they differ
 * by something the collection recorded, that difference is the honest way to
 * separate them; a bare number is the last resort.
 */
function disambiguators(item: MediaItem): string[] {
  const tags = tagsOf(item)
  const stated = [tags.year, tags.publisher, tags.version, ...tags.unknown]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
  return [...new Set([...stated, '2', '3', '4', '5', '6', '7', '8', '9'])]
}

/** A title, where it will be written, and whether its name had to be changed. */
export type PlannedName = {
  item: MediaItem
  /** The set this title belongs to; see {@link TransferOperation.group}. */
  group: string
  /** Always `/`-separated and relative to the destination root. */
  relativePath: string
  /**
   * True when a suffix had to be added to keep this title apart from another
   * that reduced to the same name.
   */
  disambiguated: boolean
}

/**
 * Where every title in a collection will be written.
 *
 * The whole collection is in hand here and nowhere else, which is why this is
 * where a set's size is worked out and where two titles that would land on one
 * path are separated. Leaving it to the planner would only get the write
 * refused, and leaving it to the user would mean explaining a collision they
 * did not cause.
 */
export function plannedNames(items: readonly MediaItem[], profile: Profile): PlannedName[] {
  const sets = setIndexOf(items)
  const taken = new Set<string>()

  return items.map((item) => {
    const folder = outputFolder(item, profile)
    const set = sets.get(item.id) ?? SINGLE_DISC
    // Built one at a time: a name is only ever contested by a handful of
    // titles, and computing every alternative for every title regardless cost
    // thirteen times what naming the library actually needs.
    const preferred = outputFileName(item, profile, set)
    let name = preferred
    if (taken.has(joinRelative(folder, name).toLowerCase())) {
      for (const value of disambiguators(item)) {
        name = outputFileName(item, profile, set, ` (${value})`)
        if (!taken.has(joinRelative(folder, name).toLowerCase())) break
      }
    }
    const relativePath = joinRelative(folder, name)
    taken.add(relativePath.toLowerCase())
    return { item, relativePath, disambiguated: name !== preferred, group: setKeyOf(item) }
  })
}

/**
 * Turns a collection into the copy operations the native planner expects.
 */
export function transferOperations(
  items: MediaItem[],
  profile: Profile,
): TransferOperation[] {
  return plannedNames(items, profile).map(({ item, relativePath, group }) => ({
    source: item.path,
    relativePath,
    size: item.size,
    group,
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
