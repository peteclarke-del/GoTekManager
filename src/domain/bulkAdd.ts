/**
 * Filling a profile from every local source at once.
 *
 * Adding titles one at a time is fine for a handful and hopeless for a
 * collection: an organised set holds half a dozen near-copies of each title —
 * the original dump, an alternate, a crack, a bad dump, a translation, a
 * playable demo — and picking through them by hand is the work this is meant
 * to remove.
 *
 * Two rules carry the weight. The first is that a **set is only useful whole**:
 * a filter that takes disc 1 and rejects disc 3 because somebody re-dumped it
 * writes a game that cannot be finished, so discs are chosen together, not
 * separately. The second is that where several copies of one title survive the
 * filter, **the best one is chosen** rather than all of them, working down from
 * the original through the alternates in the order the collection's own flags
 * imply.
 *
 * Like everything else built on release tags, none of this knows which machine
 * is being prepared; the caller decides that by handing in the titles for one
 * platform.
 */

import { acceptedFormats } from './catalog'
import { isOnTarget } from './presence'
import { forProfile, outputFolder, plannedNames, setKeyOf, tagsOf } from './media'
import {
  dumpRank,
  releaseSignature,
  type DevStatus,
  type Distribution,
  type DumpFlag,
  type ReleaseTags,
} from './tags'
import type { MediaItem, Profile, TargetFileStatus } from './types'

/**
 * Which titles a scan should take.
 *
 * Every dimension has an "any" state rather than an empty-means-everything
 * rule, because an empty list is a real answer: nobody wants "no languages at
 * all" to quietly mean "every language".
 */
export type ScanFilter = {
  /** Source folders to read. Empty means every source. */
  sourcePaths: string[]
  /** Language codes to accept, and whether a title that states none is taken. */
  languages: { include: string[]; includeUntagged: boolean } | 'any'
  /** Unfinished builds to allow in. Empty means finished releases only. */
  devStatus: DevStatus[]
  /** Dump flags to tolerate. An untagged or verified dump is always taken. */
  dumpFlags: DumpFlag[]
  distribution: Distribution[] | 'any'
  regions: string[] | 'any'
  /** Category ids to take, plus `'none'` for the ones nothing has sorted. */
  categories: string[] | 'any'
  /** Only formats this profile's machine and firmware can agree on. */
  acceptedFormatsOnly: boolean
  keepDiskSetsWhole: boolean
  onePerTitle: boolean
  onlyMissingFromTarget: boolean
}

/** The category filter's value for a title nothing has sorted. */
export const NO_CATEGORY = 'none'

/**
 * The filter a scan starts from: everything anybody would actually want on a
 * stick, and nothing they would then have to delete.
 */
export const CLEAN_RELEASES: ScanFilter = {
  sourcePaths: [],
  languages: 'any',
  devStatus: [],
  dumpFlags: [],
  distribution: 'any',
  regions: 'any',
  categories: 'any',
  acceptedFormatsOnly: true,
  keepDiskSetsWhole: true,
  onePerTitle: true,
  onlyMissingFromTarget: false,
}

export type ScanPreset = { id: string; name: string; summary: string; filter: ScanFilter }

export const SCAN_PRESETS: ScanPreset[] = [
  {
    id: 'clean',
    name: 'Clean releases',
    summary: 'Finished releases with nothing done to them. One copy of each title.',
    filter: CLEAN_RELEASES,
  },
  {
    id: 'alternates',
    name: 'Clean plus alternates',
    summary: 'Also allows fixed and alternate dumps where no original was kept.',
    filter: { ...CLEAN_RELEASES, dumpFlags: ['fixed', 'alternate'] },
  },
  {
    id: 'english',
    name: 'English only',
    summary: 'Clean releases stating English, or stating no language at all.',
    filter: {
      ...CLEAN_RELEASES,
      languages: { include: ['en'], includeUntagged: true },
    },
  },
  {
    id: 'everything',
    name: 'Everything',
    summary: 'No filtering by tag at all, and every copy of every title.',
    filter: {
      ...CLEAN_RELEASES,
      devStatus: ['alpha', 'beta', 'preview', 'prototype', 'sample', 'demo'],
      dumpFlags: [
        'fixed',
        'alternate',
        'trained',
        'translated',
        'cracked',
        'hacked',
        'modified',
        'pirate',
        'overdump',
        'underdump',
        'bad',
        'virus',
      ],
      acceptedFormatsOnly: false,
      onePerTitle: false,
      keepDiskSetsWhole: false,
    },
  },
]

export type Verdict = { included: true } | { included: false; reason: string }

const TAKEN: Verdict = { included: true }

/** Why a title was left out, in the words the preview shows. */
export const REASONS = {
  format: 'a format this drive cannot load',
  source: 'from a source that was not scanned',
  category: 'not one of the chosen categories',
  onTarget: 'already on the target',
  staged: 'already in this profile',
  incomplete: 'part of a set that is missing a disc',
  superseded: 'a better copy of this title was chosen',
} as const

function reason(text: string): Verdict {
  return { included: false, reason: text }
}

/**
 * Whether one title passes the filter, and if not, why.
 *
 * The reason matters as much as the verdict: a scan that says "4,812 titles
 * were left out" and nothing else is impossible to trust or to correct.
 */
export function judge(
  item: MediaItem,
  tags: ReleaseTags,
  filter: ScanFilter,
  accepted: readonly string[],
): Verdict {
  if (filter.sourcePaths.length && !filter.sourcePaths.includes(item.source)) {
    return reason(REASONS.source)
  }
  if (filter.acceptedFormatsOnly && !accepted.includes(`.${item.extension}`)) {
    return reason(REASONS.format)
  }
  if (filter.categories !== 'any') {
    const held = item.category || NO_CATEGORY
    if (!filter.categories.includes(held)) return reason(REASONS.category)
  }
  if (tags.devStatus && !filter.devStatus.includes(tags.devStatus)) {
    return reason(`a ${tags.devStatus} build`)
  }
  const unwanted = tags.dumpFlags.filter(
    (flag) => flag !== 'verified' && !filter.dumpFlags.includes(flag),
  )
  if (unwanted.length) return reason(`marked ${unwanted.join(' and ')}`)

  if (filter.languages !== 'any') {
    const { include, includeUntagged } = filter.languages
    if (!tags.languages.length) {
      // A multi-language release states that it is one without listing which,
      // so it is treated as stating a language rather than stating nothing.
      if (!includeUntagged && !tags.multiLanguage) return reason('states no language')
    } else if (!tags.languages.some((code) => include.includes(code))) {
      return reason(`in ${tags.languages.join(', ')}`)
    }
  }
  if (filter.distribution !== 'any') {
    const held = tags.distribution ?? 'commercial'
    if (!filter.distribution.includes(held as Distribution)) {
      return reason(`published as ${held}`)
    }
  }
  if (filter.regions !== 'any' && tags.regions.length) {
    if (!tags.regions.some((code) => (filter.regions as string[]).includes(code))) {
      return reason(`for ${tags.regions.join(', ')}`)
    }
  }
  return TAKEN
}

// ---------------------------------------------------------------------------
// Assembling sets
// ---------------------------------------------------------------------------

type Candidate = { item: MediaItem; tags: ReleaseTags }

/** One title's set: everything that belongs to it, and what it needs. */
type DiscSet = {
  key: string
  members: Candidate[]
  /** Every disc position the set is known to have, in a stable order. */
  positions: string[]
}

/** The position a member fills. A set of one has a single unnamed position. */
function positionOf(tags: ReleaseTags): string {
  return tags.disk?.label ?? ''
}

/**
 * Groups titles into sets, and works out which discs each set should have.
 *
 * The positions come from *every* member, not only the ones that passed the
 * filter, because that is the whole point: a set whose second disc exists only
 * as a bad dump has to know the disc is missing rather than silently become a
 * one-disc game.
 */
function discSets(items: readonly MediaItem[]): DiscSet[] {
  const groups = new Map<string, DiscSet>()
  for (const item of items) {
    const key = setKeyOf(item)
    const tags = tagsOf(item)
    const group = groups.get(key) ?? { key, members: [], positions: [] }
    group.members.push({ item, tags })
    const position = positionOf(tags)
    if (!group.positions.includes(position)) group.positions.push(position)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    // A set that says it has three discs has three, however many turned up.
    const stated = Math.max(
      0,
      ...group.members.map((member) => member.tags.disk?.of ?? 0),
    )
    // Filled the way this set labels itself. A set of sides A and B that says
    // it has two must look for B, not for a `D2` that can never arrive.
    const lettered = group.positions.some((position) => /^[A-Z]$/.test(position))
    const label = (disc: number) =>
      lettered ? String.fromCharCode('A'.charCodeAt(0) + disc - 1) : `D${disc}`
    for (let disc = 1; disc <= stated; disc += 1) {
      if (!group.positions.includes(label(disc))) group.positions.push(label(disc))
    }
    // A single unnamed position alongside real discs is not a position of its
    // own: it is a member the collection never labelled.
    if (group.positions.length > 1) {
      group.positions = group.positions.filter((position) => position !== '')
      if (!group.positions.length) group.positions = ['']
    }
    group.positions.sort()
  }
  return [...groups.values()]
}

/** Best first: the original, then the fixed dump, then the alternates. */
function byPreference(left: Candidate, right: Candidate): number {
  const rank = dumpRank(left.tags) - dumpRank(right.tags)
  if (rank) return rank
  const finished = Number(Boolean(left.tags.devStatus)) - Number(Boolean(right.tags.devStatus))
  if (finished) return finished
  // Stable and explicable: the shorter name, then the path. Two runs over one
  // library must stage the same files, whatever order they arrived in.
  const length = left.item.name.length - right.item.name.length
  if (length) return length
  return left.item.path.localeCompare(right.item.path)
}

type SetOutcome = {
  key: string
  chosen: MediaItem[]
  /** Discs no surviving copy could fill. */
  missing: string[]
  /** True when the set had to be built from more than one release. */
  mixed: boolean
}

/**
 * Chooses which copies of one title to take.
 *
 * A whole set from one release beats a set assembled out of several, so every
 * release is tried in preference order first; only when no single release
 * covers every disc is the set filled disc by disc, and then it is reported as
 * mixed rather than passed off as a clean set.
 */
function assembleSet(set: DiscSet, passed: Set<string>): SetOutcome {
  const survivors = set.members
    .filter((member) => passed.has(member.item.id))
    .sort(byPreference)

  const releases = new Map<string, Candidate[]>()
  for (const member of survivors) {
    const signature = releaseSignature(member.tags)
    releases.set(signature, [...(releases.get(signature) ?? []), member])
  }

  for (const members of releases.values()) {
    const covered = new Set(members.map((member) => positionOf(member.tags)))
    if (set.positions.every((position) => covered.has(position))) {
      const chosen = set.positions.map(
        (position) => members.find((member) => positionOf(member.tags) === position)!.item,
      )
      return { key: set.key, chosen, missing: [], mixed: false }
    }
  }

  const chosen: MediaItem[] = []
  const missing: string[] = []
  const used = new Set<string>()
  for (const position of set.positions) {
    const best = survivors.find((member) => positionOf(member.tags) === position)
    if (!best) {
      missing.push(position || 'the only disc')
      continue
    }
    chosen.push(best.item)
    used.add(releaseSignature(best.tags))
  }
  return { key: set.key, chosen, missing, mixed: used.size > 1 }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type ExclusionGroup = { reason: string; count: number; examples: string[] }

export type FolderGroup = {
  folder: string
  categoryId?: string
  items: MediaItem[]
  bytes: number
}

export type BulkAddPlan = {
  /** Titles this scan would stage, already committed to the profile's machine. */
  included: MediaItem[]
  /** How many titles were considered at all, before any filtering. */
  considered: number
  excluded: ExclusionGroup[]
  byFolder: FolderGroup[]
  /** Included titles nothing has categorised, which a category layout buckets. */
  unsorted: MediaItem[]
  /** Sets that could not be completed, and are therefore left out. */
  incomplete: Array<{ title: string; missing: string[] }>
  /** Sets built from more than one release because no single one was whole. */
  mixed: string[]
  /** Titles renamed to keep two stripped names apart, with the name used. */
  renamed: Array<{ name: string; relativePath: string }>
  totalBytes: number
}

const HOW_MANY_EXAMPLES = 3

/**
 * Works out exactly what a scan would add, without adding anything.
 *
 * Pure, so the dialog can recompute it on every change to a filter, and so what
 * the preview promises and what staging does are the same calculation rather
 * than two that have to be kept in step.
 */
export function planBulkAdd(
  items: readonly MediaItem[],
  profile: Profile,
  platformId: string,
  filter: ScanFilter,
  options: {
    /** What the destination already holds, by source path. */
    presence?: Record<string, TargetFileStatus>
    /** Titles already staged against this profile. */
    staged?: ReadonlySet<string>
  } = {},
): BulkAddPlan {
  const accepted = acceptedFormats(platformId, profile.firmwareId)
  // Every title is read as belonging to the machine being prepared, exactly as
  // staging one by hand does, or an ambiguous format would be grouped, named
  // and compared as something it is not.
  const candidates = items.map((item) => forProfile(item, platformId))

  const excluded = new Map<string, MediaItem[]>()
  const drop = (item: MediaItem, why: string) =>
    excluded.set(why, [...(excluded.get(why) ?? []), item])

  const passed = new Set<string>()
  for (const item of candidates) {
    if (options.staged?.has(item.id)) {
      drop(item, REASONS.staged)
      continue
    }
    if (filter.onlyMissingFromTarget) {
      const status = options.presence?.[item.path]
      if (status && isOnTarget(status.status)) {
        drop(item, REASONS.onTarget)
        continue
      }
    }
    const verdict = judge(item, tagsOf(item), filter, accepted)
    if (verdict.included) passed.add(item.id)
    else drop(item, verdict.reason)
  }

  const included: MediaItem[] = []
  const incomplete: BulkAddPlan['incomplete'] = []
  const mixed: string[] = []

  if (!filter.onePerTitle && !filter.keepDiskSetsWhole) {
    included.push(...candidates.filter((item) => passed.has(item.id)))
  } else {
    for (const set of discSets(candidates)) {
      // A set nothing survived is not an incomplete set: it was left out for
      // whatever reason its members were, and saying it is short of a disc
      // would explain it twice and wrongly.
      if (!set.members.some((member) => passed.has(member.item.id))) continue
      const outcome = assembleSet(set, passed)
      const title = tagsOf(outcome.chosen[0] ?? set.members[0].item).bareTitle
      if (outcome.missing.length && filter.keepDiskSetsWhole) {
        incomplete.push({ title, missing: outcome.missing })
        for (const member of set.members) {
          if (passed.has(member.item.id)) drop(member.item, REASONS.incomplete)
        }
        continue
      }
      const chosen = filter.onePerTitle
        ? outcome.chosen
        : set.members.filter((member) => passed.has(member.item.id)).map((member) => member.item)
      const kept = new Set(chosen.map((item) => item.id))
      for (const member of set.members) {
        if (passed.has(member.item.id) && !kept.has(member.item.id)) {
          drop(member.item, REASONS.superseded)
        }
      }
      if (outcome.mixed && chosen.length) mixed.push(title)
      included.push(...chosen)
    }
  }

  // The order the library was in, so a preview reads like the table behind it.
  const order = new Map(candidates.map((item, index) => [item.id, index]))
  included.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))

  const folders = new Map<string, FolderGroup>()
  for (const item of included) {
    const folder = outputFolder(item, profile) || '/'
    const group = folders.get(folder) ?? {
      folder,
      categoryId: item.category,
      items: [],
      bytes: 0,
    }
    group.items.push(item)
    group.bytes += item.size
    folders.set(folder, group)
  }

  // Reducing a name to its title is what makes two titles collide, so where one
  // had to be given a suffix to stay apart from another, the preview says so: a
  // name on the drive that nobody chose is otherwise a small mystery.
  const renamed = plannedNames(included, profile)
    .filter((planned) => planned.disambiguated)
    .map((planned) => ({ name: planned.item.name, relativePath: planned.relativePath }))

  return {
    included,
    considered: candidates.length,
    excluded: [...excluded.entries()]
      .map(([reason, items]) => ({
        reason,
        count: items.length,
        examples: items.slice(0, HOW_MANY_EXAMPLES).map((item) => item.name),
      }))
      .sort((left, right) => right.count - left.count),
    byFolder: [...folders.values()].sort((left, right) =>
      left.folder.localeCompare(right.folder),
    ),
    unsorted: included.filter((item) => !item.category),
    incomplete,
    mixed,
    renamed,
    totalBytes: included.reduce((total, item) => total + item.size, 0),
  }
}
