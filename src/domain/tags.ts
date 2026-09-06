/**
 * Reading the release tags a collection writes into a filename.
 *
 * Organised retro collections do not just name a file after the game: they
 * record the year, the publisher, the region, the language, which dump this is
 * and which disc of the set, all in brackets. TOSEC's convention is the one
 * nearly all of them follow —
 *
 * ```text
 * Dungeon Master (1987)(FTL)(GB)(Disk 1 of 2)[cr QTX].adf
 * ```
 *
 * That is a great deal of information and none of it belongs on a two-line
 * display, so this module separates the two: what the title actually is, and
 * everything the collection recorded about this particular copy of it.
 *
 * **Nothing here knows which machine is being prepared.** The vocabulary is a
 * property of the naming convention, not of the hardware — the same `[a]`,
 * `(demo)`, `(de)` and `(Disk 2 of 3)` appear in Amiga `.adf`, BBC `.ssd`,
 * Amstrad `.dsk`, Spectrum `.trd` and Atari `.st` collections alike. The one
 * machine-aware decision in the application is which formats a machine and its
 * firmware can agree on, and it lives in the catalogue where it belongs.
 */

/** A build that is not the finished release. */
export type DevStatus = 'alpha' | 'beta' | 'preview' | 'prototype' | 'sample' | 'demo'

/** What was done to this copy of the software, if anything. */
export type DumpFlag =
  | 'verified'
  | 'fixed'
  | 'alternate'
  | 'trained'
  | 'translated'
  | 'cracked'
  | 'hacked'
  | 'modified'
  | 'pirate'
  | 'overdump'
  | 'underdump'
  | 'bad'
  | 'virus'

/** How the software was published. An untagged release is commercial. */
export type Distribution =
  | 'pd'
  | 'freeware'
  | 'shareware'
  | 'giftware'
  | 'licenceware'
  | 'cardware'
  | 'mailware'

/**
 * Which disc of a set this is.
 *
 * `label` is what gets written to the drive — `D2` for a numbered disc, `B` for
 * a lettered one, mirroring however the set labels itself. A number is written
 * `D2` rather than `2` because on a two-line display a bare digit reads as a
 * year or a sequel.
 */
export type DiskMarker = {
  label: string
  index?: number
  /** How many discs the set holds, when the name says so. */
  of?: number
}

export type ReleaseTags = {
  /** The title with every tag taken off: the name of the game or application. */
  bareTitle: string
  /** Lower-case language codes, in the order stated. Empty when none is. */
  languages: string[]
  /** True for the multi-language forms, `(M3)`, `(M4)`, … */
  multiLanguage: boolean
  devStatus?: DevStatus
  dumpFlags: DumpFlag[]
  distribution?: Distribution
  /** Upper-case country or region codes: `US`, `EU`, `GB`, `DE`, `JP`, … */
  regions: string[]
  disk?: DiskMarker
  /** The year of publication, as written: `1987`, `19xx`. */
  year?: string
  /** A version or revision, as written: `v1.2`, `Rev A`. */
  version?: string
  /**
   * Who published it, when the name says so.
   *
   * Never stated outright: the convention is positional, and the publisher is
   * the bracket immediately after the year. That is enough to tell two
   * otherwise identical releases apart once their names have been stripped.
   */
  publisher?: string
  /**
   * Bracketed text nothing recognised — most often the publisher.
   *
   * Kept rather than discarded so the interface can say what it dropped, and so
   * two releases that differ only by publisher can still be told apart when
   * their stripped names collide.
   */
  unknown: string[]
}

const EMPTY: ReleaseTags = {
  bareTitle: '',
  languages: [],
  multiLanguage: false,
  dumpFlags: [],
  regions: [],
  unknown: [],
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const DEV_STATUS: Record<string, DevStatus> = {
  alpha: 'alpha',
  beta: 'beta',
  preview: 'preview',
  'pre-release': 'preview',
  prerelease: 'preview',
  proto: 'prototype',
  prototype: 'prototype',
  sample: 'sample',
  demo: 'demo',
  'demo-kiosk': 'demo',
  'demo-playable': 'demo',
  'demo-rolling': 'demo',
  'demo-slideshow': 'demo',
}

/**
 * The single-letter dump flags, longest first.
 *
 * Order matters: `[tr]` is a translation and `[t]` is a trainer, so the two
 * letter codes have to be tried before the one letter ones or every
 * translation would be read as a trainer.
 */
const DUMP_FLAGS: Array<[string, DumpFlag]> = [
  ['tr', 'translated'],
  ['cr', 'cracked'],
  ['!', 'verified'],
  ['a', 'alternate'],
  ['b', 'bad'],
  ['f', 'fixed'],
  ['h', 'hacked'],
  ['m', 'modified'],
  ['o', 'overdump'],
  ['p', 'pirate'],
  ['t', 'trained'],
  ['u', 'underdump'],
  ['v', 'virus'],
]

const DISTRIBUTION: Record<string, Distribution> = {
  pd: 'pd',
  'public domain': 'pd',
  fw: 'freeware',
  freeware: 'freeware',
  sw: 'shareware',
  shareware: 'shareware',
  gw: 'giftware',
  giftware: 'giftware',
  lw: 'licenceware',
  licenceware: 'licenceware',
  licenseware: 'licenceware',
  cw: 'cardware',
  cardware: 'cardware',
  mg: 'mailware',
  mailware: 'mailware',
}

/**
 * ISO 639-1 codes a collection is likely to state.
 *
 * Case is what separates a language from a country: TOSEC writes `(de)` for
 * German and `(DE)` for Germany, and both are two letters.
 */
const LANGUAGES = new Set([
  'ar', 'bg', 'bs', 'cs', 'cy', 'da', 'de', 'el', 'en', 'eo', 'es', 'et', 'fa',
  'fi', 'fr', 'ga', 'gd', 'he', 'hr', 'hu', 'is', 'it', 'ja', 'ko', 'lt', 'lv',
  'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sq', 'sr', 'sv', 'tr', 'uk',
  'yi', 'zh',
])

const REGIONS = new Set([
  'AE', 'AS', 'AU', 'AT', 'BE', 'BR', 'CA', 'CH', 'CL', 'CN', 'CZ', 'DE', 'DK',
  'EE', 'EG', 'ES', 'EU', 'FI', 'FR', 'GB', 'GR', 'HK', 'HU', 'ID', 'IE', 'IL',
  'IN', 'IR', 'IS', 'IT', 'JP', 'KR', 'LT', 'LU', 'LV', 'MX', 'MY', 'NL', 'NO',
  'NP', 'NZ', 'PE', 'PH', 'PL', 'PT', 'RO', 'RU', 'SE', 'SG', 'SI', 'SK', 'TH',
  'TR', 'TW', 'US', 'VN', 'YU', 'ZA', 'ASIA', 'EUROPE', 'WORLD', 'USA', 'JAPAN',
])

/** `1987`, `19xx`, `198x`, `1987-06`, `1987-06-12`. */
const YEAR = /^(19|20)[0-9x]{2}(-[0-9x]{2}){0,2}$/i
const VERSION = /^(v[\d.]+[a-z]?|rev\s*[\w.]+|alt)$/i
const MULTI_LANGUAGE = /^m[2-9]$/i
/** `(en-fr)`, `(en-de-fr)`. */
const LANGUAGE_LIST = /^[a-z]{2}(-[a-z]{2})+$/i
const DISK_GROUP = /^(disk|disc|side|part|file|tape)\s*([0-9]{1,2}|[a-z])(\s*(of|\/)\s*([0-9]{1,2}))?$/i
/**
 * `Elite Disk 2`, `Lemmings side b` — the marker written without brackets.
 *
 * Also matches a name that is *only* the marker, which is what an archive entry
 * usually is: a ZIP called `Dungeon Master (1987)(FTL).zip` holding `disk1.adf`
 * and `disk2.adf`. Reading those leaves no title at all, which is exactly the
 * signal that the archive's own name is the one worth having.
 */
const TRAILING_DISK = /(?:^|\s)(?:disk|disc|side|part)\s*([0-9]{1,2}|[a-z])\s*$/i
/** A lone letter at the end, which is how most Amiga sets number their discs. */
const TRAILING_LETTER = /\s([a-z])\s*$/i

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** How a numbered or lettered disc is written on the drive. */
export function diskLabel(value: string): string {
  return /^[0-9]+$/.test(value) ? `D${Number(value)}` : value.toUpperCase()
}

/** The name with its extension taken off, and separators made readable. */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // Underscores stand in for spaces in filenames written by tools that could
  // not use them. Hyphens are left alone: plenty of titles contain one.
  return (dot > 0 ? name.slice(0, dot) : name).replace(/_+/g, ' ')
}

/** The extension including its dot, or nothing when the name has none. */
export function extensionPart(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

function readDumpFlag(content: string): DumpFlag | undefined {
  const code = content.trim().toLowerCase()
  const match = DUMP_FLAGS.find(
    ([letters]) =>
      code === letters ||
      // `[a2]`, `[cr PDX]`, `[b2 corrupt]`: a number, an annotation, or both.
      new RegExp(`^${letters.replace('!', '\\!')}\\d*(\\s.*)?$`).test(code),
  )
  return match?.[1]
}

/**
 * Reads one name.
 *
 * Every bracketed group is classified and taken out; what is left is the title.
 * A group nothing recognises is taken out too — the user asked for the game's
 * own name and nothing else — but it is kept in `unknown` so the interface can
 * report it and so two releases can still be told apart if they need to be.
 */
function readOne(name: string): ReleaseTags {
  const tags: ReleaseTags = { ...EMPTY, dumpFlags: [], languages: [], regions: [], unknown: [] }
  const stem = stemOf(name)
  let previousWasYear = false

  const bare = stem
    .replace(/([([])([^)\]]*)[)\]]/g, (_whole, bracket: string, content: string) => {
      const value = content.trim()
      if (!value) return ' '
      const lower = value.toLowerCase()
      const wasYear = previousWasYear
      previousWasYear = false

      if (bracket === '[') {
        const flag = readDumpFlag(value)
        if (flag) {
          if (!tags.dumpFlags.includes(flag)) tags.dumpFlags.push(flag)
          return ' '
        }
        tags.unknown.push(value)
        return ' '
      }

      const disk = value.match(DISK_GROUP)
      if (disk) {
        const [, , position, , , total] = disk
        tags.disk = {
          label: diskLabel(position),
          index: /^\d+$/.test(position) ? Number(position) : undefined,
          of: total ? Number(total) : undefined,
        }
        return ' '
      }
      if (YEAR.test(value)) {
        tags.year ??= value
        previousWasYear = true
        return ' '
      }
      if (VERSION.test(value)) {
        tags.version ??= value
        return ' '
      }
      if (lower in DEV_STATUS) {
        tags.devStatus ??= DEV_STATUS[lower]
        return ' '
      }
      if (lower in DISTRIBUTION) {
        tags.distribution ??= DISTRIBUTION[lower]
        return ' '
      }
      if (MULTI_LANGUAGE.test(value)) {
        tags.multiLanguage = true
        return ' '
      }
      // Case decides between a language and the country it is spoken in.
      if (LANGUAGES.has(lower) && value === lower) {
        if (!tags.languages.includes(lower)) tags.languages.push(lower)
        return ' '
      }
      if (REGIONS.has(value.toUpperCase()) && value !== lower) {
        const region = value.toUpperCase()
        if (!tags.regions.includes(region)) tags.regions.push(region)
        return ' '
      }
      if (LANGUAGE_LIST.test(value) && value === lower) {
        for (const code of lower.split('-')) {
          if (LANGUAGES.has(code) && !tags.languages.includes(code)) tags.languages.push(code)
        }
        if (tags.languages.length > 1) tags.multiLanguage = true
        return ' '
      }
      // TOSEC writes the publisher in the bracket straight after the year, so
      // that position alone identifies it even though the name never says so.
      if (wasYear) tags.publisher ??= value
      tags.unknown.push(value)
      return ' '
    })
    // Whatever the brackets left behind: doubled spaces, and the separators
    // that were only ever there to hold the tags apart.
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*$/, '')
    .trim()

  tags.bareTitle = bare
  if (tags.disk) return tags

  // Nothing bracketed said which disc this is, so the end of the name is asked.
  const trailing = bare.match(TRAILING_DISK)
  if (trailing) {
    tags.bareTitle = bare.slice(0, trailing.index).trim()

    tags.disk = {
      label: diskLabel(trailing[1]),
      index: /^\d+$/.test(trailing[1]) ? Number(trailing[1]) : undefined,
    }
    return tags
  }
  const letter = bare.match(TRAILING_LETTER)
  if (letter) {
    tags.bareTitle = bare.slice(0, letter.index).trim()
    tags.disk = { label: letter[1].toUpperCase() }
  }
  return tags
}

/**
 * Reads the tags off every name that describes one title, nearest first.
 *
 * A title inside an archive is described by two names — its own and the
 * archive's — and for the single-title ZIPs that fill most collections the
 * archive is where the tags actually are, because the file inside is often
 * just `disk1.adf`. Each field is taken from the first name that states it, so
 * the file's own name always wins where the two disagree.
 */
export function readTags(...names: Array<string | undefined>): ReleaseTags {
  const read = names.filter((name): name is string => Boolean(name?.trim())).map(readOne)
  if (!read.length) return { ...EMPTY }
  const [first, ...rest] = read
  return rest.reduce<ReleaseTags>(
    (merged, tags) => ({
      bareTitle: merged.bareTitle || tags.bareTitle,
      languages: merged.languages.length ? merged.languages : tags.languages,
      multiLanguage: merged.multiLanguage || tags.multiLanguage,
      devStatus: merged.devStatus ?? tags.devStatus,
      dumpFlags: merged.dumpFlags.length ? merged.dumpFlags : tags.dumpFlags,
      distribution: merged.distribution ?? tags.distribution,
      regions: merged.regions.length ? merged.regions : tags.regions,
      disk: merged.disk ?? tags.disk,
      year: merged.year ?? tags.year,
      version: merged.version ?? tags.version,
      publisher: merged.publisher ?? tags.publisher,
      unknown: [...merged.unknown, ...tags.unknown],
    }),
    first,
  )
}

/**
 * How good a copy of the software this is, lower being better.
 *
 * This is the order a set is assembled in: the original first, then the fixed
 * dump, then the alternates, and so on down to the dumps nobody wants. An
 * untagged release and one marked `[!]` are both the reference dump and rank
 * together; a numbered alternate keeps its own order, so `[a]` is tried before
 * `[a2]`.
 */
const FLAG_RANK: Record<DumpFlag, number> = {
  verified: 0,
  fixed: 1,
  alternate: 2,
  trained: 3,
  translated: 3,
  cracked: 4,
  hacked: 4,
  modified: 4,
  pirate: 5,
  overdump: 6,
  underdump: 6,
  bad: 7,
  virus: 8,
}

export function dumpRank(tags: ReleaseTags): number {
  if (!tags.dumpFlags.length) return 0
  return Math.max(...tags.dumpFlags.map((flag) => FLAG_RANK[flag]))
}

/**
 * What identifies one release of a title across its discs.
 *
 * Two discs belong to the same release when the collection recorded the same
 * things about them, which is what lets a set be taken whole from one release
 * rather than assembled out of several.
 */
export function releaseSignature(tags: ReleaseTags): string {
  return [
    [...tags.dumpFlags].sort().join('+') || 'original',
    tags.year ?? '',
    tags.version ?? '',
    tags.languages.join('+'),
    tags.regions.join('+'),
  ].join('|')
}
