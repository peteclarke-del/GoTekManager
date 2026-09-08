/**
 * Frontend checks.
 *
 * Run with `npm run check`. These cover the pure domain rules, the workspace
 * reducer, and the migration from the pre-2.0 storage layout — the parts where
 * a mistake would quietly corrupt someone's library or plan the wrong write.
 *
 * They use only Node's own assertions and the esbuild that ships with Vite, so
 * the project gains a test story without gaining a dependency.
 */

import { storage } from './environment'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { App } from '../src/App'
import { forTesting } from '../src/state/persistence.native'
import { ALL_HELP_SCREENS, HELP_THEMES } from '../src/pages/helpScreens'

import {
  acceptedFormats,
  firmwareProfiles,
  inferPlatformId,
  mentionsPlatform,
  namesAnotherPlatform,
  platforms,
  requireFirmware,
  requirePlatform,
  supportedExtensions,
} from '../src/domain/catalog'
import {
  belongsToPlatform,
  classifyMedia,
  elideMiddle,
  forProfile,
  formatBytes,
  isFirmwareCompatible,
  isOutsideProfile,
  managedFormats,
  namingChoice,
  outputFileName,
  outputFolder,
  releaseName,
  renderFolderTemplate,
  setIndexOf,
  softwareTitleKey,
  transferOperations,
} from '../src/domain/media'
import {
  categories,
  categoryFolder,
  categoryFolderFor,
  categoryFromSource,
  inferCategoryFor,
  destinationCategoryFolders,
  inferCategory,
  inferCategoryFromName,
  inferCategoryId,
  UNCATEGORISED,
} from '../src/domain/categories'
import { dumpRank, readTags, releaseSignature } from '../src/domain/tags'
import {
  costOf,
  isExcluded,
  keptFiles,
  looksLikeSetup,
  proposeExclusions,
  titleOf,
  treeOf,
  type HeldFile,
} from '../src/domain/deviceBuild'
import {
  CLEAN_RELEASES,
  judge,
  REASONS,
  planBulkAdd,
  SCAN_PRESETS,
  type ScanFilter,
} from '../src/domain/bulkAdd'
import {
  basename,
  dottedExtensionOf,
  hasParent,
  joinRelative,
  parentPath,
  relativeTo,
  safeFileName,
  toPosix,
} from '../src/domain/paths'
import {
  configFor,
  configSupport,
  DISPLAY_CHOICES,
  flashFloppyConfig,
  mergeFlashFloppyConfig,
} from '../src/domain/firmwareConfig'
import { blockedTitles, isOnDestination, summarisePlan } from '../src/domain/plan'
import {
  defaultProviders,
  faultIn,
  mergeProviders,
  providersFor,
  readCustomProviders,
  readProviderConfig,
} from '../src/domain/providers'
import { downloadSourceOf, groupDownloads } from '../src/domain/downloads'
import { countBy, omitKey, removeById, upsertById } from '../src/domain/records'
import { isNewer, newerRelease, parseVersion } from '../src/domain/version'
import {
  coverageOf,
  rangeOf,
  retained,
  toggled,
  withAll,
} from '../src/domain/selection'
import type {
  FileEntry,
  MediaItem,
  Profile,
  PublishedRelease,
  TransferPlan,
  TransferResultEntry,
} from '../src/domain/types'
import { reviveTablePreferences } from '../src/state/useWorkspace'
import {
  loadSettings,
  loadWorkspace,
  reviveSettings,
  splitWorkspace,
} from '../src/state/migrations'
import {
  collectionOf,
  createProfile,
  emptyWorkspace,
  isWritable,
  profileIdFor,
  profilesForMounts,
  workspaceReducer,
  type Workspace,
} from '../src/state/workspace'

let failures = 0
let passes = 0

function check(name: string, body: () => void) {
  try {
    body()
    passes += 1
  } catch (reason) {
    failures += 1
    console.error(`\n  FAIL  ${name}`)
    console.error(`        ${reason instanceof Error ? reason.message : String(reason)}`)
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

check('parent navigation stops at a POSIX or Windows root', () => {
  assert.equal(parentPath('/media/pclarke/GOTEK'), '/media/pclarke')
  assert.equal(parentPath('/media'), '/')
  assert.equal(parentPath('/'), '/')
  assert.equal(hasParent('/'), false)
  assert.equal(hasParent('/media'), true)

  assert.equal(parentPath('C:\\GOTEK\\BBC'), 'C:\\GOTEK')
  assert.equal(parentPath('C:\\GOTEK'), 'C:\\')
  assert.equal(parentPath('C:\\'), 'C:\\')
  assert.equal(hasParent('C:\\'), false)
  assert.equal(hasParent('C:\\GOTEK'), true)
})

check('basenames and extensions read both separators', () => {
  assert.equal(basename('/library/bbc/Elite.ssd'), 'Elite.ssd')
  assert.equal(basename('C:\\library\\bbc\\Elite.ssd'), 'Elite.ssd')
  assert.equal(dottedExtensionOf('Elite.SSD'), '.ssd')
  assert.equal(dottedExtensionOf('README'), '')
})

check('destination-relative paths are always POSIX', () => {
  assert.equal(relativeTo('C:\\GOTEK', 'C:\\GOTEK\\BBC\\Elite.ssd'), 'BBC/Elite.ssd')
  assert.equal(relativeTo('/media/gotek', '/media/gotek/BBC/Elite.ssd'), 'BBC/Elite.ssd')
  assert.equal(joinRelative('BBC/', '/Elite.ssd'), 'BBC/Elite.ssd')
  assert.equal(toPosix('BBC\\Elite.ssd'), 'BBC/Elite.ssd')
})

check('output filenames are made safe for FAT', () => {
  assert.equal(safeFileName('Elite: The Sequel?.ssd'), 'Elite_ The Sequel_.ssd')
  assert.equal(safeFileName('..'), '_')
  assert.equal(safeFileName('   '), 'Untitled')
})

// ---------------------------------------------------------------------------
// Media rules
// ---------------------------------------------------------------------------

function entry(name: string, size = 1024): FileEntry {
  return {
    name,
    path: `/library/${name}`,
    extension: name.split('.').pop()!.toLowerCase(),
    size,
    directory: false,
  }
}

check('an unambiguous format is assigned and a shared one is not', () => {
  const bbc = classifyMedia(entry('Elite.ssd'), '/library')
  const shared = classifyMedia(entry('Sorcery.dsk'), '/library')

  assert.equal(bbc.assignedPlatformId, undefined)
  assert.ok(bbc.likelyPlatformIds.includes('bbc'))
  assert.ok(bbc.likelyPlatformIds.includes('electron'))
  // .dsk is claimed by several machines, so it must stay unassigned.
  assert.equal(shared.assignedPlatformId, undefined)
  assert.ok(shared.likelyPlatformIds.length > 1)

  const only = classifyMedia(entry('Game.atr'), '/library')
  assert.equal(only.assignedPlatformId, 'atari-8bit')
})

check('an unassigned title still matches its likely platform', () => {
  const item = classifyMedia(entry('Elite.ssd'), '/library')

  assert.equal(belongsToPlatform(item, 'bbc'), true)
  assert.equal(belongsToPlatform(item, 'c64'), false)
  assert.equal(belongsToPlatform({ ...item, assignedPlatformId: 'electron' }, 'bbc'), false)
})

/** A library title, named as a collection would name it. */
function media(name: string, platformId = 'bbc'): MediaItem {
  return { ...classifyMedia(entry(name), '/library'), assignedPlatformId: platformId }
}

check('a title is written under its own name and nothing else', () => {
  // Everything a collection records about a release — the year, the publisher,
  // the region, the language, the dump — says which copy this is. None of it
  // says what the software is, and none of it fits a two-line display.
  assert.equal(
    releaseName(media('Dungeon Master (1987)(FTL)(GB)[cr QTX].adf', 'amiga')),
    'Dungeon Master.adf',
  )
  assert.equal(releaseName(media('Elite (1984)(Acornsoft).ssd')), 'Elite.ssd')
  assert.equal(releaseName(media('Zool 1 (Gremlin).adf', 'amiga')), 'Zool 1.adf')
  assert.equal(releaseName(media('Turrican II (1991 demo).adf', 'amiga')), 'Turrican II.adf')

  // A title whose own name looks like a tag is still its own name.
  assert.equal(releaseName(media('Elite II.ssd')), 'Elite II.ssd')
  assert.equal(releaseName(media('Rick Dangerous II.adf', 'amiga')), 'Rick Dangerous II.adf')
  assert.equal(releaseName(media('SWIV.ssd')), 'SWIV.ssd')
})

check('a disc is only marked when the set has more than one', () => {
  // A one-disc game is called what it is. Numbering a set of one says nothing
  // and takes room the display does not have.
  const single = [media('Elite (1984).ssd')]
  assert.equal(releaseName(single[0], setIndexOf(single).get(single[0].id)), 'Elite.ssd')

  // The whole point of the marker: two discs must never arrive at one name.
  // They did, and the write refused — a four-disc game became one file's worth
  // of collisions, because the letter telling them apart sits exactly where
  // trimming cuts.
  const set = [
    media('Another World (1991)(Delphine + U.S. Gold) A.adf', 'amiga'),
    media('Another World (1991)(Delphine + U.S. Gold) B.adf', 'amiga'),
    media('Another World (1991)(Delphine + U.S. Gold) C.adf', 'amiga'),
  ]
  const positions = setIndexOf(set)
  const names = set.map((item) => releaseName(item, positions.get(item.id), 24))
  assert.equal(new Set(names).size, 3, `two discs share a name: ${names.join(', ')}`)
  assert.deepEqual(names, [
    'Another World A.adf',
    'Another World B.adf',
    'Another World C.adf',
  ])

  // However the set writes it. A number becomes D2, which on a two-line
  // display cannot be read as a year or a sequel.
  const numbered = [media('Elite (Disk 1 of 2).adf', 'amiga'), media('Elite (Disk 2 of 2).adf', 'amiga')]
  const marked = setIndexOf(numbered)
  assert.deepEqual(
    numbered.map((item) => releaseName(item, marked.get(item.id))),
    ['Elite D1.adf', 'Elite D2.adf'],
  )

  // Written without brackets, or as a side, and read just the same.
  const loose = [media('Monkey Island Disk 4.adf', 'amiga'), media('Monkey Island Disk 3.adf', 'amiga')]
  assert.equal(
    releaseName(loose[0], setIndexOf(loose).get(loose[0].id)),
    'Monkey Island D4.adf',
  )
  const sides = [media('Lemmings (Side A).adf', 'amiga'), media('Lemmings (Side B).adf', 'amiga')]
  assert.equal(releaseName(sides[1], setIndexOf(sides).get(sides[1].id)), 'Lemmings B.adf')

  // A set says how many discs it has even when only one of them is here, so a
  // disc that arrives on its own is still numbered rather than renamed.
  const partial = [media('Elite (Disk 1 of 3).adf', 'amiga')]
  assert.equal(releaseName(partial[0], setIndexOf(partial).get(partial[0].id)), 'Elite D1.adf')
})

check('a disc number is found in the middle of a name, and survives the cut', () => {
  // Written as "Data Disk #6 - Suzi & Melissa": the number is mid-name and
  // carries a hash, so it was not read as a disc at all. Each disc became a set
  // of its own, and when the display width cut the name to something two discs
  // shared, the year was borrowed to tell them apart — which says nothing about
  // which disc is which, and is the one thing somebody at the machine needs.
  const sixth = readTags('Strip Poker Three Data Disk #6 - Suzi & Melissa (1991)(Artworx).adf')
  assert.equal(sixth.bareTitle, 'Strip Poker Three Data')
  assert.equal(sixth.disk?.label, 'D6')
  assert.equal(sixth.disk?.index, 6)

  const set = [
    media('Strip Poker Three Data Disk #5 - Suzi & Melissa (1991)(Artworx).adf', 'amiga'),
    media('Strip Poker Three Data Disk #6 - Suzi & Melissa (1991)(Artworx).adf', 'amiga'),
  ]
  const positions = setIndexOf(set)
  assert.deepEqual(
    set.map((item) => releaseName(item, positions.get(item.id), 24)),
    ['Strip Poker Three D5.adf', 'Strip Poker Three D6.adf'],
    'the disc number is what tells them apart, not the year',
  )

  // A number that is not a disc marker is left where it is.
  assert.equal(
    readTags('Amiga Format Coverdisk 42 Extra.adf').bareTitle,
    'Amiga Format Coverdisk 42 Extra',
  )
  assert.equal(readTags('Elite Disk 2.adf').bareTitle, 'Elite')
  // Including the marker this application writes itself, so a stick it built
  // reads back as the sets it was built from.
  assert.equal(readTags('Elite D2.adf').bareTitle, 'Elite')
  assert.equal(readTags('Elite D2.adf').disk?.label, 'D2')
})

check('a name cut for the display gives up the title, never the disc', () => {
  assert.equal(
    releaseName(media('A Very Long Retro Game Title Indeed.ssd'), undefined, 24),
    'A Very Long Retro Ga.ssd',
  )
  // Factory firmware has a much smaller display.
  assert.ok(releaseName(media('Elite.ssd'), undefined, 8).length <= 8)

  const set = [
    media('An Extremely Long Amiga Game Title Without Brackets A.adf', 'amiga'),
    media('An Extremely Long Amiga Game Title Without Brackets B.adf', 'amiga'),
  ]
  const positions = setIndexOf(set)
  assert.equal(
    releaseName(set[1], positions.get(set[1].id), 24),
    'An Extremely Long B.adf',
  )
  // Even with no room at all, the disc is what survives.
  const tight = releaseName(set[1], positions.get(set[1].id), 20)
  assert.ok(tight.length <= 20)
  assert.ok(tight.endsWith(' B.adf'), tight)
})

check('every route into the library writes the same name', () => {
  // A title scanned from a folder, one read out of an archive, and one
  // downloaded from a catalogue are the same software and must arrive on the
  // drive under the same name, or a stick becomes a mixture of conventions.
  const profile: Profile = { ...bbcProfile, platformId: 'amiga', folderLayout: 'flat' }
  const scanned = media('Dungeon Master (1987)(FTL)(GB).adf', 'amiga')
  const archived: MediaItem = {
    ...scanned,
    id: '/library/Dungeon Master (1987)(FTL)(GB).zip!/disk1.adf',
    path: '/library/Dungeon Master (1987)(FTL)(GB).zip!/disk1.adf',
    name: 'disk1.adf',
  }
  const downloaded: MediaItem = {
    ...scanned,
    id: '/cache/dl/Dungeon Master (1987)(FTL)(GB).adf',
    path: '/cache/dl/Dungeon Master (1987)(FTL)(GB).adf',
  }

  for (const item of [scanned, archived, downloaded]) {
    const [operation] = transferOperations([item], profile)
    assert.equal(operation.relativePath, 'Dungeon Master.adf', item.path)
  }
})

check('two titles that reduce to one name are kept apart', () => {
  // Stripping a name to its title is exactly what makes two files collide. The
  // planner would refuse the write; naming them apart is better than explaining
  // a collision the user did not cause.
  const profile: Profile = { ...bbcProfile, folderLayout: 'flat' }
  const operations = transferOperations(
    [media('Elite (1984)(Acornsoft).ssd'), media('Elite (1987)(Firebird).ssd')],
    profile,
  )

  assert.equal(operations[0].relativePath, 'Elite.ssd')
  assert.notEqual(operations[1].relativePath, operations[0].relativePath)
  // The difference the collection itself recorded, rather than a bare number.
  assert.equal(operations[1].relativePath, 'Elite (1987).ssd')
})

check('title keys normalise enough to compare, and no further', () => {
  assert.equal(softwareTitleKey('Elite (1984) [cr].ssd'), 'elite')
  assert.equal(softwareTitleKey('/library/Chuckie Egg.ssd'), 'chuckie egg')
  assert.equal(softwareTitleKey('Dungeon Master Disk 2.adf'), 'dungeon master')
  assert.notEqual(softwareTitleKey('Elite II'), softwareTitleKey('Elite'))
})

check('a blocked title says where it would go and what is already there', () => {
  // "This would overwrite another title" is not something anybody can act on:
  // dropping the right one of the pair means seeing both, and the path.
  const first = media('Strip Poker Three Data Disk 6 (1991)(Artworx).ssd')
  const second = {
    ...media('Strip Poker Three Data Disk 6 (1991)(Artworx)[a].ssd'),
    id: 'second',
    path: '/library/other/Strip Poker Three Data Disk 6 (1991)(Artworx)[a].ssd',
  }
  const operations = [
    { source: first.path, relativePath: 'Games/Strip Poker.ssd', size: 1024 },
    { source: second.path, relativePath: 'Games/Strip Poker.ssd', size: 1024 },
  ]
  const plan: TransferPlan = {
    target: '/media/gotek',
    operations: [],
    edits: [],
    removals: [],
    result: [],
    totalBytes: 0,
    warnings: [],
    ready: false,
    blockers: [
      {
        kind: 'collision' as const,
        source: second.path,
        message: 'Two titles would be written to Games/Strip Poker.ssd',
      },
    ],
  }

  const [blockedTitle] = blockedTitles(
    plan,
    new Map([
      [first.path, first],
      [second.path, second],
    ]),
    operations,
  )

  assert.equal(blockedTitle.item.id, 'second')
  assert.equal(blockedTitle.path, 'Games/Strip Poker.ssd')
  assert.equal(blockedTitle.against?.id, first.id, 'the title already taking that path')
})

check('byte sizes are readable', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(200 * 1024), '200 KB')
  assert.equal(formatBytes(-1), '—')
})

const bbcProfile: Profile = {
  id: 'profile:/media/gotek',
  name: 'GOTEK',
  destination: { kind: 'folder', path: '/media/gotek' },
  platformId: 'bbc',
  firmwareId: 'flashfloppy',
  organise: true,
  folderLayout: 'platform',
  naming: 'oled',
}

check('an unassigned title is read as belonging to the profile being prepared', () => {
  const shared = classifyMedia(entry('Sorcery.dsk'), '/library')
  assert.equal(shared.assignedPlatformId, undefined)

  // Without this the library table would compare against a flat path while the
  // plan wrote into a platform folder, and an existing file would read as new.
  const [asBbc] = transferOperations([forProfile(shared, 'cpc464')], {
    ...bbcProfile,
    platformId: 'cpc464',
  })
  assert.equal(asBbc.relativePath, 'CPC464/Sorcery.dsk')

  // An explicit assignment is never overridden.
  const assigned = { ...shared, assignedPlatformId: 'spectrum128' }
  assert.equal(forProfile(assigned, 'cpc464').assignedPlatformId, 'spectrum128')
})

check('transfer operations apply the profile layout and naming', () => {
  const set = [media('Elite (Disk 1).ssd'), media('Elite (Disk 2).ssd')]

  // The disk number survives the shortening: it is the only thing telling this
  // file apart from the rest of its set, and dropping it made them collide.
  const [organised] = transferOperations(set, bbcProfile)
  assert.equal(organised.relativePath, 'BBC/Elite D1.ssd')

  const [flat] = transferOperations(set, { ...bbcProfile, folderLayout: 'flat' })
  assert.equal(flat.relativePath, 'Elite D1.ssd')

  const [original] = transferOperations(set, { ...bbcProfile, naming: 'original' })
  assert.equal(original.relativePath, 'BBC/Elite (Disk 1).ssd')

  const [unorganised] = transferOperations(set, { ...bbcProfile, organise: false })
  assert.equal(unorganised.relativePath, 'Elite D1.ssd')
})

check('a custom folder template expands its tokens', () => {
  const item: MediaItem = {
    ...classifyMedia(entry('Elite (1984).ssd'), '/library'),
    assignedPlatformId: 'bbc',
  }

  assert.equal(renderFolderTemplate('{platform}', item), 'BBC')
  assert.equal(renderFolderTemplate('{family}/{platform}', item), 'Acorn/BBC')
  // Alphabetical grouping is what makes thousands of titles navigable on a
  // two-line display.
  assert.equal(renderFolderTemplate('{platform}/{initial}', item), 'BBC/E')
  assert.equal(renderFolderTemplate('{format}', item), 'SSD')

  // A typo stays visible rather than silently reshaping the whole layout.
  assert.equal(renderFolderTemplate('{platfrm}', item), '{platfrm}')
  // Digits share one bucket and symbols another, which is the convention every
  // large collection uses and what a real GoTek stick looks like.
  assert.equal(renderFolderTemplate('{initial}', { ...item, canonicalTitle: '1942.ssd' }), '0-9')
  assert.equal(renderFolderTemplate('{initial}', { ...item, canonicalTitle: '007.dsk' }), '0-9')
  assert.equal(renderFolderTemplate('{initial}', { ...item, canonicalTitle: '!Boot.ssd' }), 'B')
  assert.equal(renderFolderTemplate('{initial}', { ...item, canonicalTitle: '___.ssd' }), '#')
})

check('an unassigned title lands in a named bucket, not a broken path', () => {
  const orphan = classifyMedia(entry('Mystery.dsk'), '/library')

  assert.equal(renderFolderTemplate('{platform}', orphan), 'Unsorted')
})

check('a category layout splits the stick by what the titles are', () => {
  const game: MediaItem = { ...classifyMedia(entry('Elite.ssd'), '/library'), category: 'games' }
  const mag: MediaItem = { ...classifyMedia(entry('Beebug 1.ssd'), '/library'), category: 'magazines' }
  const loose = classifyMedia(entry('Unknown.ssd'), '/library')
  const profile: Profile = { ...bbcProfile, folderLayout: 'category' }

  assert.equal(outputFolder(game, profile), 'Games')
  assert.equal(outputFolder(mag, profile), 'Mags')
  // Everything nobody has sorted shares one folder rather than the root, so a
  // later sort is a matter of moving one folder's contents.
  assert.equal(outputFolder(loose, profile), UNCATEGORISED)
  // Turning organising off still means one flat stick, whatever the layout says.
  assert.equal(outputFolder(game, { ...profile, organise: false }), '')

  // The two can be combined, which is what a multi-machine stick needs. The
  // platform has to be committed for that, exactly as staging a title does it.
  assert.equal(
    outputFolder(
      { ...game, assignedPlatformId: 'bbc' },
      { ...profile, folderLayout: 'custom', folderTemplate: '{platform}/{category}' },
    ),
    'BBC/Games',
  )
})

check('a custom layout drives the actual destination path', () => {
  const item: MediaItem = {
    ...classifyMedia(entry('Elite (1984).ssd'), '/library'),
    assignedPlatformId: 'bbc',
  }
  const custom: Profile = {
    ...bbcProfile,
    folderLayout: 'custom',
    folderTemplate: '{platform}/{initial}',
  }

  const [operation] = transferOperations([item], custom)

  // The layout decides the folder and the naming rule decides the file: the
  // year is something the collection recorded about this copy, not part of what
  // the software is called, so it does not reach the drive.
  assert.equal(operation.relativePath, 'BBC/E/Elite.ssd')
})

check('naming and layout decide where a title is written, never what it is', () => {
  // The property the whole comparison now rests on: two profiles that write the
  // same title to completely different paths are still describing one file, so
  // whether the media already holds it cannot depend on either setting.
  const item: MediaItem = {
    ...classifyMedia(entry('Zynaps (1987)(Hewson Consultants).dsk'), '/library'),
    assignedPlatformId: 'cpc464',
  }
  const oledPlatform: Profile = {
    ...bbcProfile,
    platformId: 'cpc464',
    folderLayout: 'platform',
    naming: 'oled',
  }
  const originalInitial: Profile = {
    ...bbcProfile,
    platformId: 'cpc464',
    folderLayout: 'custom',
    folderTemplate: '{initial}',
    naming: 'original',
  }

  const [a] = transferOperations([item], oledPlatform)
  const [b] = transferOperations([item], originalInitial)

  // The year and the publisher go, because neither says which file this is and
  // the drive's display cannot hold them.
  assert.equal(a.relativePath, 'CPC464/Zynaps.dsk')
  assert.equal(b.relativePath, 'Z/Zynaps (1987)(Hewson Consultants).dsk')
  // Different destinations, same source file. Identity lives in the contents,
  // which the native side compares; neither path is the file's identity.
  assert.notEqual(a.relativePath, b.relativePath)
  assert.equal(a.source, b.source)
  assert.equal(a.size, b.size)
})

check('a display alias decides the written name and nothing else', () => {
  const item: MediaItem = {
    ...classifyMedia(entry('Elite (1984).ssd'), '/library'),
    assignedPlatformId: 'bbc',
  }

  // Without an alias, the profile's naming rule applies.
  assert.equal(outputFileName(item, bbcProfile), 'Elite.ssd')

  const aliased = { ...item, displayTitle: 'ELITE' }
  assert.equal(outputFileName(aliased, bbcProfile), 'ELITE.ssd')
  // The library's own record is untouched, so nothing is lost.
  assert.equal(aliased.canonicalTitle, 'Elite (1984).ssd')

  // An alias that already carries the extension is not given a second one.
  assert.equal(
    outputFileName({ ...item, displayTitle: 'ELITE.ssd' }, bbcProfile),
    'ELITE.ssd',
  )
  // An alias never changes which folder the title lands in.
  assert.equal(outputFolder(aliased, bbcProfile), outputFolder(item, bbcProfile))
  // An empty alias falls back to the generated name.
  assert.equal(outputFileName({ ...item, displayTitle: '  ' }, bbcProfile), 'Elite.ssd')
})

check('firmware compatibility needs the machine, the firmware, and the format', () => {
  const bbc: MediaItem = {
    ...classifyMedia(entry('Elite.ssd'), '/library'),
    assignedPlatformId: 'bbc',
  }
  assert.equal(isFirmwareCompatible(bbc, 'flashfloppy'), true)
  // The BBC profile does not list factory GoTek firmware at all.
  assert.equal(isFirmwareCompatible(bbc, 'gotek-standard'), false)
  // An unassigned title cannot be judged compatible.
  assert.equal(isFirmwareCompatible(classifyMedia(entry('Elite.ssd'), '/l'), 'flashfloppy'), false)

  // The case the old model could not express: a genuine Atari 8-bit disk image
  // that one firmware loads and the other cannot.
  const atari: MediaItem = {
    ...classifyMedia(entry('Game.atr'), '/library'),
    assignedPlatformId: 'atari-8bit',
  }
  assert.equal(isFirmwareCompatible(atari, 'flashfloppy'), true)
  assert.equal(isFirmwareCompatible(atari, 'hxc'), false)
})

check('the removal policy only ever covers what this drive can load', () => {
  assert.equal(isOutsideProfile(bbcProfile, 'BBC/Elite.ssd'), false)
  // Firmware configuration is never managed content.
  assert.equal(isOutsideProfile(bbcProfile, 'FF.CFG'), true)
  // A format the pairing cannot load is not this profile's to delete.
  const hxcAtari: Profile = { ...bbcProfile, platformId: 'atari-8bit', firmwareId: 'hxc' }
  assert.deepEqual(managedFormats(hxcAtari), ['.hfe'])
  assert.equal(isOutsideProfile(hxcAtari, 'Game.atr'), true)
})

check('a GoTek emulates a floppy, so no tape, cartridge, or flux format is listed', () => {
  // Every one of these was previously listed and none can be loaded from the
  // stick by any GoTek firmware.
  const impossible = [
    '.tap', '.tzx', '.uef',   // tape images
    '.prg', '.crt', '.nex',   // programs, cartridges, snapshots
    '.ipf', '.atx',           // flux and copy-protection preservation
    '.d64', '.g64', '.d71',   // Commodore GCR, not an MFM floppy
    '.scl', '.msa',           // archives needing conversion to .hfe first
  ]
  for (const format of impossible) {
    assert.equal(
      supportedExtensions.has(format),
      false,
      `${format} must not be an accepted GoTek format`,
    )
  }
})

check('every platform format is loadable by at least one of its firmwares', () => {
  for (const platform of platforms) {
    for (const format of platform.formats) {
      const loadable = platform.firmwareIds.some((id) =>
        acceptedFormats(platform.id, id).includes(format),
      )
      assert.ok(loadable, `${platform.name} lists ${format} but no firmware can load it`)
    }
  }
})

check('accepted formats are the platform and firmware intersection', () => {
  // FlashFloppy reads Atari 8-bit .atr directly; HxC cannot.
  assert.deepEqual(acceptedFormats('atari-8bit', 'flashfloppy'), ['.atr', '.hfe'])
  assert.deepEqual(acceptedFormats('atari-8bit', 'hxc'), ['.hfe'])
  // Factory firmware only reads raw sector images.
  assert.deepEqual(acceptedFormats('cpc464', 'gotek-standard'), ['.img'])
  // The universal container is available everywhere.
  for (const firmware of firmwareProfiles.filter((entry) => entry.id !== 'gotek-standard')) {
    assert.ok(firmware.formats.includes('.hfe'))
  }
})

check('Commodore 8-bit profiles offer only the MFM 1581 format', () => {
  for (const id of ['c64', 'c128', 'plus4']) {
    assert.deepEqual(requirePlatform(id).formats, ['.d81', '.hfe'])
  }
})

check('catalogue lookups always resolve', () => {
  assert.equal(requirePlatform('bbc').name, 'Acorn BBC Micro')
  assert.equal(requirePlatform('nope').id, 'bbc')
  assert.equal(requireFirmware(undefined).id, 'flashfloppy')
  assert.equal(inferPlatformId('My Amiga Stick'), 'amiga')
  assert.equal(inferPlatformId('Untitled'), 'bbc')
})

// ---------------------------------------------------------------------------
// Reading a plan
// ---------------------------------------------------------------------------

function resultEntry(entry: Partial<TransferResultEntry>): TransferResultEntry {
  return { path: 'x.ssd', status: 'add', ...entry }
}

function planWith(result: TransferResultEntry[]): TransferPlan {
  return {
    target: '/media/gotek',
    operations: [],
    edits: [],
    removals: [],
    result,
    totalBytes: 0,
    warnings: [],
    blockers: [],
    ready: true,
  }
}

check('a planned addition is not counted as already being on the destination', () => {
  // The native side omits currentSize for an addition. If it ever sends null
  // instead, a strict `!== undefined` test would count it as present, which is
  // exactly the miscount this guards.
  assert.equal(isOnDestination(resultEntry({ status: 'add', resultSize: 200 })), false)
  assert.equal(
    isOnDestination({ path: 'x.ssd', status: 'add', currentSize: null } as never),
    false,
  )
  assert.equal(isOnDestination(resultEntry({ status: 'unchanged', currentSize: 200 })), true)
})

check('the summary counts what is there now, what changes, and what results', () => {
  const plan = planWith([
    resultEntry({ path: 'BBC/Aviator.ssd', status: 'add', resultSize: 200 }),
    resultEntry({ path: 'BBC/Elite.ssd', status: 'add', resultSize: 200 }),
    resultEntry({
      path: 'BBC/Chuckie Egg.ssd',
      status: 'unchanged',
      currentSize: 200,
      resultSize: 200,
    }),
    resultEntry({ path: 'BBC/Snapper.ssd', status: 'unchanged', currentSize: 200, resultSize: 200 }),
    // Firmware configuration is not recognised media and must not be counted.
    resultEntry({ path: 'FF.CFG', status: 'unchanged', currentSize: 32, resultSize: 32 }),
  ])

  const summary = summarisePlan(plan, bbcProfile)

  assert.equal(summary.entries.length, 4)
  assert.equal(summary.currentCount, 2)
  assert.equal(summary.resultCount, 4)
  assert.equal(summary.counts.add, 2)
  assert.equal(summary.counts.remove, 0)
  assert.equal(summary.hasChanges, true)
})

check('the titles in the way of a write are named, so they can be taken out', () => {
  const gone = classifyMedia(entry('Gone.ssd'), '/library')
  const first = classifyMedia(entry('Another World A.ssd'), '/library')
  const second = classifyMedia(entry('Another World B.ssd'), '/library')
  const bySource = new Map([gone, first, second].map((item) => [item.path, item]))

  const blocked = blockedTitles(
    {
      ...planWith([]),
      ready: false,
      warnings: ['Source is unavailable: /library/Gone.ssd'],
      blockers: [
        {
          kind: 'unavailable',
          source: '/library/Gone.ssd',
          message: 'Source is unavailable: /library/Gone.ssd',
        },
        {
          kind: 'collision',
          source: '/library/Another World B.ssd',
          message: 'Two titles would be written to AW.ssd',
        },
        // The same title twice says nothing new, and a blocker about something
        // that is not staged cannot be acted on here.
        {
          kind: 'collision',
          source: '/library/Another World B.ssd',
          message: 'Two titles would be written to AW.ssd',
        },
        { kind: 'other', message: 'Not enough room on the destination.' },
      ],
    },
    bySource,
  )

  assert.deepEqual(
    blocked.map((title) => [title.kind, title.item.name]),
    [
      ['unavailable', 'Gone.ssd'],
      ['collision', 'Another World B.ssd'],
    ],
  )
  // The first of a colliding pair keeps its place; only the later one is named.
  assert.ok(!blocked.some((title) => title.item.name === 'Another World A.ssd'))
})

check('a plan with nothing to do reports no changes', () => {
  const summary = summarisePlan(
    planWith([
      resultEntry({ path: 'BBC/Elite.ssd', status: 'unchanged', currentSize: 200, resultSize: 200 }),
    ]),
    bbcProfile,
  )

  assert.equal(summary.hasChanges, false)
  assert.equal(summary.currentCount, 1)
  assert.deepEqual(summarisePlan(null, bbcProfile).entries, [])
})

check('destination files this drive cannot load are flagged, not counted as ours', () => {
  const hxcAtari: Profile = { ...bbcProfile, platformId: 'atari-8bit', firmwareId: 'hxc' }

  const summary = summarisePlan(
    planWith([
      resultEntry({ path: 'Game.atr', status: 'unchanged', currentSize: 90, resultSize: 90 }),
    ]),
    hxcAtari,
  )

  assert.equal(summary.mismatches.length, 1)
  assert.deepEqual(summary.mismatchFormats, ['.atr'])
})

// ---------------------------------------------------------------------------
// Online sources
// ---------------------------------------------------------------------------

check('a listing entry that names another machine is not offered', () => {
  // The complaint this exists for: an Amstrad compilation turning up in a BBC
  // search and being offered for a BBC stick.
  assert.equal(namesAnotherPlatform('Amstrad CPC Games Collection', 'bbc'), true)
  assert.equal(namesAnotherPlatform('Elite (BBC Micro)', 'bbc'), false)
  // A title naming both is kept: a compilation may hold discs for each.
  assert.equal(namesAnotherPlatform('Elite: BBC Micro and Amstrad CPC', 'bbc'), false)
  // Most titles name no machine at all, and guessing would lose them.
  assert.equal(namesAnotherPlatform('Chuckie Egg', 'bbc'), false)

  // The family alone can never separate two machines that share it.
  assert.equal(namesAnotherPlatform('Commodore 64 demos', 'amiga'), true)
  assert.equal(namesAnotherPlatform('Amiga demos', 'amiga'), false)
  assert.equal(mentionsPlatform('ZX Spectrum Next games', 'next'), true)
  assert.equal(mentionsPlatform('Acorn Electron tape archive', 'bbc'), false)
})

check('every machine can be searched on the Archive under its own name', () => {
  for (const platform of platforms) {
    const archive = providersFor(defaultProviders, platform.id).filter(
      (provider) => provider.adapter === 'internetArchive',
    )
    assert.ok(
      archive.length > 0,
      `${platform.name} has no Internet Archive source of its own`,
    )
  }
})

check('every platform has somewhere to look beyond the Internet Archive', () => {
  for (const platform of platforms) {
    const available = providersFor(defaultProviders, platform.id)
    assert.ok(available.length > 0, `${platform.name} has no online source at all`)

    // The Archive is one catalogue with one set of gaps. New software for these
    // machines is published on community sites, so each platform needs at least
    // a couple of those as well.
    const elsewhere = available.filter(
      (provider) => provider.adapter !== 'internetArchive' && provider.platformId,
    )
    assert.ok(
      elsewhere.length >= 2,
      `${platform.name} has ${elsewhere.length} non-Archive sources; it needs at least 2`,
    )
  }
})

check('a hand-written source list is validated rather than half-obeyed', () => {
  const load = readProviderConfig({
    version: 1,
    providers: [
      { id: 'good', name: 'Good', adapter: 'htmlSite', platformId: 'bbc', catalogUrl: 'https://example.org/' },
      { id: 'good', name: 'Duplicate', adapter: 'htmlSite', platformId: 'bbc', catalogUrl: 'https://example.org/' },
      { id: '', name: 'Nameless', adapter: 'htmlSite', platformId: 'bbc', catalogUrl: 'https://example.org/' },
      { id: 'insecure', name: 'Insecure', adapter: 'htmlSite', platformId: 'bbc', catalogUrl: 'http://example.org/' },
      { id: 'unknown', name: 'Unknown', adapter: 'telepathy' },
      { id: 'noquery', name: 'No query', adapter: 'internetArchive', platformId: 'bbc' },
      { id: 'nomachine', name: 'No machine', adapter: 'htmlSite', catalogUrl: 'https://example.org/' },
      { id: 'whatmachine', name: 'Odd machine', adapter: 'htmlSite', platformId: 'zx81', catalogUrl: 'https://example.org/' },
      'not an object',
    ],
  })

  assert.deepEqual(load.providers.map((provider) => provider.id), ['good'])
  assert.equal(load.problems.length, 8)
  // Every rejection names what was wrong, so a typo is findable.
  assert.ok(load.problems.some((problem) => problem.includes('repeats the id')))
  assert.ok(load.problems.some((problem) => problem.includes('https://')))
  assert.ok(load.problems.some((problem) => problem.includes('unknown adapter')))
  assert.ok(load.problems.some((problem) => problem.includes('which machine')))
  assert.ok(load.problems.some((problem) => problem.includes('unknown machine')))
})

check('a source of the user\'s own is held to the same standard as one that ships', () => {
  const load = readCustomProviders([
    { id: 'mine', name: 'Mine', adapter: 'htmlSite', platformId: 'bbc', catalogUrl: 'https://example.org/' },
    // Saved before every source had to name a machine.
    { id: 'legacy', name: 'Everything', adapter: 'htmlSite', catalogUrl: 'https://example.org/' },
  ])

  assert.deepEqual(load.providers.map((provider) => provider.id), ['mine'])
  // Named, so it can be put right, rather than vanishing from every machine.
  assert.equal(load.problems.length, 1)
  assert.ok(load.problems[0].includes('Everything'))
})

check('a file with no providers array is refused outright', () => {
  assert.deepEqual(readProviderConfig(null).providers, [])
  assert.deepEqual(readProviderConfig({ version: 1 }).providers, [])
  assert.ok(readProviderConfig({}).problems[0].includes('providers'))
})

check('the shipped file parses and every entry survives validation', () => {
  // The bundled JSON is hand-edited, so a stray comma or a mistyped adapter
  // would otherwise only show up as sources quietly missing at runtime.
  assert.ok(defaultProviders.length > 20)
  const load = readProviderConfig({ version: 1, providers: defaultProviders })
  assert.deepEqual(load.problems, [])
})

check('a source for one machine never appears while preparing another', () => {
  const forCpc = providersFor(defaultProviders, 'cpc464').map((provider) => provider.id)

  // The BBC archives are useless here and must not be offered.
  assert.ok(!forCpc.includes('stairway-bbc'))
  assert.ok(!forCpc.includes('ia-c64'))
  assert.ok(forCpc.includes('ia-cpc464'))

  const forBbc = providersFor(defaultProviders, 'bbc').map((provider) => provider.id)
  assert.ok(forBbc.includes('stairway-bbc'))
  assert.ok(!forBbc.includes('stairway-electron'))
  // Every source names one machine, so nothing is shown for all of them.
  assert.ok(defaultProviders.every((provider) => provider.platformId))
  for (const platform of platforms) {
    const listed = providersFor(defaultProviders, platform.id)
    assert.ok(
      listed.every((provider) => provider.platformId === platform.id),
      `${platform.name} is offered a source for another machine`,
    )
  }
})

check('every shipped source is complete and points somewhere real', () => {
  const ids = new Set<string>()
  for (const provider of defaultProviders) {
    assert.ok(!ids.has(provider.id), `duplicate provider id ${provider.id}`)
    ids.add(provider.id)
    assert.ok(provider.name.trim().length > 0)
    assert.equal(provider.builtIn, true)

    if (provider.platformId) {
      assert.ok(
        platforms.some((platform) => platform.id === provider.platformId),
        `${provider.id} names a platform that does not exist: ${provider.platformId}`,
      )
    }
    if (provider.adapter === 'htmlSite') {
      // Anything crawled must be HTTPS; the native side enforces this too.
      assert.ok(provider.catalogUrl?.startsWith('https://'), `${provider.id} needs an HTTPS URL`)
    } else {
      assert.ok(provider.query, `${provider.id} needs a query`)
    }
  }
})

check('nothing that ships ignores a site or disguises itself', () => {
  // The override is a decision the person at the keyboard makes for one source.
  // A default that arrived with it set would be making that decision for them,
  // and for everyone who builds this repository.
  for (const provider of defaultProviders) {
    assert.ok(
      !provider.ignoreRobots,
      `${provider.id} ships ignoring robots.txt, which must never be a default`,
    )
    assert.equal(
      provider.userAgent,
      undefined,
      `${provider.id} ships with a custom identity; the default names the application`,
    )
  }
})

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

check('a title inside an archive reads as a title like any other', () => {
  // The library lists archive entries rather than unpacking them, so a title's
  // path can name the archive it lives in. Everything the interface does with
  // it — its name, its format, where it came from — has to keep working.
  const item = classifyMedia(
    {
      name: 'Elite (1988).adf',
      path: '/library/Amiga/Games/Elite (1988).zip!/Elite (1988).adf',
      extension: 'adf',
      size: 901120,
      directory: false,
    },
    '/library/Amiga',
  )

  assert.equal(item.canonicalTitle, 'Elite (1988).adf')
  assert.equal(item.extension, 'adf')
  assert.ok(item.likelyPlatformIds.includes('amiga'))
  // The path is the identity, so two entries in one archive stay distinct.
  assert.equal(item.id, '/library/Amiga/Games/Elite (1988).zip!/Elite (1988).adf')
  // The folders above the archive still say what kind of title it is.
  assert.equal(item.category, 'games')
  // It is written under its own name, not the archive's.
  assert.equal(
    outputFileName({ ...item, assignedPlatformId: 'amiga' }, { ...bbcProfile, naming: 'original' }),
    'Elite (1988).adf',
  )
  // And it reads as coming from the archive, which is where the user put it.
  assert.equal(
    relativeTo('/library/Amiga', item.path),
    'Games/Elite (1988).zip!/Elite (1988).adf',
  )
})

check('a category is read from the folders a collection files its titles under', () => {
  const source = '/library/TOSEC/Commodore/Amiga'
  assert.equal(
    inferCategoryId(`${source}/Applications/[ADF]/Deluxe Paint.adf`, source),
    'applications',
  )
  // TOSEC qualifies a folder with the format it holds; the name still reads.
  assert.equal(inferCategoryId(`${source}/Games [ADF]/Elite.adf`, source), 'games')
  assert.equal(inferCategoryId(`${source}/Magazines/Amiga Format 1.adf`, source), 'magazines')
  assert.equal(inferCategoryId(`${source}/Demos/Desert Dream.adf`, source), 'demos')

  // The deepest folder is the one that says what these files actually are.
  assert.equal(inferCategoryId(`${source}/Games/Utilities/Trainer.adf`, source), 'utilities')

  // Nothing recognisable is left unset rather than guessed at.
  assert.equal(inferCategoryId(`${source}/Misc/Something.adf`, source), undefined)
  assert.equal(inferCategoryId(`${source}/Elite.adf`, source), undefined)
})

check('a folder above the source never decides a title s category', () => {
  // The library lives under a folder called Games; that says nothing about the
  // magazines inside it, or every title would come back a game.
  const source = '/library/Games'
  assert.equal(inferCategoryId(`${source}/Magazines/Zzap 1.adf`, source), 'magazines')
  assert.equal(inferCategoryId(`${source}/Elite.adf`, source), undefined)
})

check('a title with no telling folders is read by its own name', () => {
  // A download has no folders to read: it lands in a cache named after the site
  // and the download. Its name is the only evidence there is.
  assert.equal(inferCategoryFromName('Zool 1 (Gremlin) demo.adf'), 'demos')
  assert.equal(inferCategoryFromName('Amiga Format 42 coverdisk.adf'), 'magazines')
  assert.equal(inferCategoryFromName('SysInfo v4.4 utility.adf'), 'utilities')

  // Whole words only. "Demolition" is not a demo, and a game show is not a
  // game — a wrong category is silent and puts a title in the wrong folder.
  assert.equal(inferCategoryFromName('Demolition Man.adf'), undefined)
  assert.equal(inferCategoryFromName('Gameshow Quiz.adf'), undefined)
  assert.equal(inferCategoryFromName('Another World A.adf'), undefined)

  // Folders first, name second: the folders a collection files a title under
  // are the better evidence, and only the name is left when there are none.
  const source = '/library/TOSEC/Amiga'
  assert.equal(inferCategory(`${source}/Games/Elite demo.adf`, source), 'games')
  assert.equal(
    inferCategory('/cache/downloads/site-1/dl_AAA/images/Elite demo.adf', '/cache', 'Elite demo.adf'),
    'demos',
  )
})

// ---------------------------------------------------------------------------
// Release tags
// ---------------------------------------------------------------------------

check('release tags read the same on every machine', () => {
  // The vocabulary belongs to the naming convention, not to the hardware. If
  // any of this needed a per-machine rule the whole design would be wrong, so
  // one name per machine is checked against one set of expectations.
  const named = [
    'Elite (1984)(Acornsoft)(GB)[cr]. ssd',
    'Elite (1984)(Acornsoft)(GB)[cr].ssd',
    'Elite (1984)(Firebird)(GB)[cr].adf',
    'Elite (1984)(Firebird)(GB)[cr].dsk',
    'Elite (1984)(Firebird)(GB)[cr].trd',
    'Elite (1984)(Firebird)(GB)[cr].st',
    'Elite (1984)(Firebird)(GB)[cr].atr',
  ]
  for (const name of named) {
    const tags = readTags(name)
    assert.equal(tags.bareTitle, 'Elite', name)
    assert.equal(tags.year, '1984', name)
    assert.deepEqual(tags.regions, ['GB'], name)
    assert.deepEqual(tags.dumpFlags, ['cracked'], name)
  }
})

check('every group of a release name is read, and nothing is silently dropped', () => {
  const tags = readTags('Dungeon Master (1987)(FTL)(GB)(Disk 1 of 2)[cr QTX].adf')

  assert.equal(tags.bareTitle, 'Dungeon Master')
  assert.equal(tags.year, '1987')
  assert.equal(tags.publisher, 'FTL')
  assert.deepEqual(tags.regions, ['GB'])
  assert.deepEqual(tags.dumpFlags, ['cracked'])
  assert.deepEqual(tags.disk, { label: 'D1', index: 1, of: 2 })

  // A numbered or annotated flag is still that flag.
  assert.deepEqual(readTags('Elite [a2].ssd').dumpFlags, ['alternate'])
  assert.deepEqual(readTags('Elite [b2 corrupt].ssd').dumpFlags, ['bad'])
  assert.deepEqual(readTags('Elite [tr en].ssd').dumpFlags, ['translated'])
  // `[tr]` is a translation and `[t]` a trainer: reading one as the other would
  // put every translated game in the wrong bucket.
  assert.deepEqual(readTags('Elite [t].ssd').dumpFlags, ['trained'])

  // Case is what separates a language from the country it is spoken in.
  assert.deepEqual(readTags('Elite (de).adf').languages, ['de'])
  assert.deepEqual(readTags('Elite (DE).adf').regions, ['DE'])
  assert.deepEqual(readTags('Elite (DE).adf').languages, [])
  assert.equal(readTags('Elite (M4).adf').multiLanguage, true)

  // A bracket nothing recognised is part of no rule, but it is not thrown away:
  // it is what tells two otherwise identical releases apart.
  assert.deepEqual(readTags('Elite (Some Publisher).ssd').unknown, ['Some Publisher'])

  // An unfinished build says so, and is not a demoscene production.
  assert.equal(readTags('Zool (1992)(Gremlin)(demo).adf').devStatus, 'demo')
  assert.equal(readTags('Zool (1992)(Gremlin)(proto).adf').devStatus, 'prototype')
  assert.equal(readTags('Elite (1984)(PD).ssd').distribution, 'pd')
})

check('a title that states no language is never read as English', () => {
  // The convention is that it usually is. Assuming so silently would take a few
  // thousand untagged files out of an English-only scan without saying why.
  assert.deepEqual(readTags('Elite (1984).ssd').languages, [])
  assert.equal(readTags('Elite (1984).ssd').multiLanguage, false)
})

check('the preference order runs from the original down to the unwanted', () => {
  const rank = (name: string) => dumpRank(readTags(name))

  assert.equal(rank('Elite (1984).ssd'), rank('Elite (1984)[!].ssd'))
  assert.ok(rank('Elite (1984).ssd') < rank('Elite (1984)[f].ssd'))
  assert.ok(rank('Elite (1984)[f].ssd') < rank('Elite (1984)[a].ssd'))
  assert.ok(rank('Elite (1984)[a].ssd') < rank('Elite (1984)[cr].ssd'))
  assert.ok(rank('Elite (1984)[cr].ssd') < rank('Elite (1984)[b].ssd'))

  // Two discs belong to one release when the collection recorded the same
  // things about them, which is what lets a set be taken whole.
  assert.equal(
    releaseSignature(readTags('Elite (1984)(Acornsoft)(Disk 1 of 2).ssd')),
    releaseSignature(readTags('Elite (1984)(Acornsoft)(Disk 2 of 2).ssd')),
  )
  assert.notEqual(
    releaseSignature(readTags('Elite (1984)(Disk 1 of 2).ssd')),
    releaseSignature(readTags('Elite (1984)(Disk 2 of 2)[a].ssd')),
  )
})

// ---------------------------------------------------------------------------
// Adding from every source at once
// ---------------------------------------------------------------------------

const scanProfile: Profile = { ...bbcProfile, folderLayout: 'flat', naming: 'title' }

function scan(names: string[], filter: ScanFilter = CLEAN_RELEASES) {
  return planBulkAdd(names.map((name) => media(name)), scanProfile, 'bbc', filter)
}

function written(names: string[], filter: ScanFilter = CLEAN_RELEASES): string[] {
  return scan(names, filter).included.map((item) => item.name).sort()
}

check('a scan takes one copy of a title, the original first', () => {
  const names = [
    'Elite (1984)(Acornsoft)[cr].ssd',
    'Elite (1984)(Acornsoft)[a].ssd',
    'Elite (1984)(Acornsoft).ssd',
  ]
  assert.deepEqual(written(names), ['Elite (1984)(Acornsoft).ssd'])

  // No original kept, so the next best is taken rather than nothing.
  assert.deepEqual(
    written(['Elite (1984)[a2].ssd', 'Elite (1984)[a].ssd'], {
      ...CLEAN_RELEASES,
      dumpFlags: ['alternate'],
    }),
    ['Elite (1984)[a].ssd'],
  )

  // Whatever order the library was read in.
  const shuffled = [...names].reverse()
  assert.deepEqual(written(shuffled), written(names))
})

check('a set is taken whole from one release where one is whole', () => {
  // Disc 1 exists twice and disc 2 only once. Taking the best disc 1 and the
  // best disc 2 separately would build the game out of two different releases
  // when one release holds all of it.
  const plan = scan(
    [
      'Dungeon Master (1987)(FTL)(Disk 1 of 2).ssd',
      'Dungeon Master (1987)(FTL)(Disk 2 of 2).ssd',
      'Dungeon Master (1987)(FTL)(Disk 1 of 2)[a].ssd',
    ],
    { ...CLEAN_RELEASES, dumpFlags: ['alternate'] },
  )

  assert.equal(plan.included.length, 2)
  assert.deepEqual(plan.mixed, [])
  assert.deepEqual(
    plan.included.map((item) => item.name).sort(),
    [
      'Dungeon Master (1987)(FTL)(Disk 1 of 2).ssd',
      'Dungeon Master (1987)(FTL)(Disk 2 of 2).ssd',
    ],
  )
})

check('a set with no whole release is filled disc by disc, and says so', () => {
  const plan = scan(
    [
      'Dungeon Master (1987)(FTL)(Disk 1 of 2).ssd',
      'Dungeon Master (1987)(FTL)(Disk 2 of 2)[a].ssd',
    ],
    { ...CLEAN_RELEASES, dumpFlags: ['alternate'] },
  )

  assert.equal(plan.included.length, 2)
  assert.deepEqual(plan.mixed, ['Dungeon Master'])
})

check('a disc that only exists in a refused form is taken rather than lost', () => {
  // The case a real collection is full of: every copy of one disc is cracked,
  // which is simply how most of this software circulated, while another disc
  // has a clean dump. Refusing the set loses a game that plays perfectly well
  // over a preference about one of its discs, so the cascade carries on down
  // to the copy that does exist — and says which disc it did that for.
  const names = [
    'Dungeon Master (1987)(FTL)(Disk 1 of 3).ssd',
    'Dungeon Master (1987)(FTL)(Disk 2 of 3)[cr CSL].ssd',
    'Dungeon Master (1987)(FTL)(Disk 3 of 3).ssd',
  ]
  const plan = scan(names)

  assert.equal(plan.included.length, 3, 'the whole set is written')
  assert.deepEqual(plan.incomplete, [])
  assert.deepEqual(plan.compromised, [{ title: 'Dungeon Master', discs: ['D2'] }])
  // And it is the cracked copy that was taken, because it is the only one.
  assert.ok(
    plan.included.some((item) => item.name.includes('[cr CSL]')),
    'the only copy of disc 2 is the one taken',
  )
})

check('a set is only reported missing when no copy of a disc exists', () => {
  const plan = scan([
    'Dungeon Master (1987)(FTL)(Disk 1 of 3).ssd',
    'Dungeon Master (1987)(FTL)(Disk 3 of 3).ssd',
  ])

  assert.deepEqual(plan.included, [])
  assert.deepEqual(plan.incomplete, [{ title: 'Dungeon Master', missing: ['D2'] }])
  assert.deepEqual(plan.compromised, [])

  // Told not to keep sets whole, it takes what passed and says nothing.
  const loose = scan(
    [
      'Dungeon Master (1987)(FTL)(Disk 1 of 3).ssd',
      'Dungeon Master (1987)(FTL)(Disk 3 of 3).ssd',
    ],
    { ...CLEAN_RELEASES, keepDiskSetsWhole: false },
  )
  assert.equal(loose.included.length, 2)
  assert.deepEqual(loose.incomplete, [])

  // A set that labels its discs with letters is completed with letters. Looking
  // for a `D2` that can never arrive would leave every lettered set incomplete.
  const sides = scan([
    'Another World (1991)(Delphine)(Side A of 2).ssd',
    'Another World (1991)(Delphine)(Side B of 2).ssd',
  ])
  assert.equal(sides.included.length, 2)
  assert.deepEqual(sides.incomplete, [])

  const half = scan(['Another World (1991)(Delphine)(Side A of 2).ssd'])
  assert.deepEqual(half.incomplete, [{ title: 'Another World', missing: ['B'] }])

  // A set nothing survived was not left out for want of a disc: it was left out
  // for whatever reason its members were, and saying both explains it twice.
  const none = scan(['Another World (1991)[b].adf', 'Another World (1991)[b] B.adf'])
  assert.deepEqual(none.incomplete, [])
  assert.deepEqual(
    none.excluded.map((group) => group.reason),
    ['marked bad'],
  )
})

check('a point release does not look like a set with its discs missing', () => {
  // Collections ship a point release as a patched first disc only. Keeping the
  // version in the title made that single disc look like a nine disc set with
  // eight discs missing, while the complete earlier release sat beside it.
  assert.equal(readTags('Ambermoon v1.04 (1993)(Thalion)(Disk 1 of 9).adf').bareTitle, 'Ambermoon')
  assert.equal(readTags('Ambermoon v1.04 (1993)(Thalion)(Disk 1 of 9).adf').version, 'v1.04')
  assert.equal(readTags('3D Construction Kit II r2.01 (1992)(Domark).adf').bareTitle, '3D Construction Kit II')
  // A release can carry two of them, and one pass left the number behind —
  // which put every point release back in a set of its own.
  assert.equal(
    readTags('AmigaVision v1.71 rev I (1991)(Commodore)(Disk 1 of 6).adf').bareTitle,
    'AmigaVision',
  )

  // A title that merely ends in a numeral is not a version.
  assert.equal(readTags('Zool 2 (1993)(Gremlin).adf').bareTitle, 'Zool 2')
  assert.equal(readTags('Turrican II (1991)(Rainbow Arts).adf').bareTitle, 'Turrican II')

  const plan = scan([
    'Ambermoon v1.01 (1993)(Thalion)(Disk 1 of 2).ssd',
    'Ambermoon v1.01 (1993)(Thalion)(Disk 2 of 2).ssd',
    'Ambermoon v1.04 (1993)(Thalion)(Disk 1 of 2).ssd',
  ])
  assert.deepEqual(plan.incomplete, [])
  assert.equal(plan.included.length, 2, 'one complete set, not a phantom short one')
})

check('a media label never renumbers the disc it follows', () => {
  // `(Disk 2 of 3)(Disk1)` is disc two carrying a label that says "Disk1".
  // Letting the label win renumbered the set and lost its last disc.
  const tags = readTags('Abduction (1998)(Epic)(Disk 2 of 3)(Disk1).adf')
  assert.deepEqual(tags.disk, { label: 'D2', index: 2, of: 3 })

  const plan = scan([
    'Abduction (1998)(Epic)(Disk 1 of 3)(Game).ssd',
    'Abduction (1998)(Epic)(Disk 2 of 3)(Disk1).ssd',
    'Abduction (1998)(Epic)(Disk 3 of 3)(Disk2).ssd',
  ])
  assert.deepEqual(plan.incomplete, [])
  assert.equal(plan.included.length, 3)
})

check('a set is as long as the collection bears out, not as long as anyone claims', () => {
  // Two editions: a complete four disc release, and a five disc one whose last
  // disc nobody kept. Believing the larger claim left the complete set out.
  const complete = scan([
    'Dragonstone (1994)(Core)(Disk 1 of 4).ssd',
    'Dragonstone (1994)(Core)(Disk 2 of 4).ssd',
    'Dragonstone (1994)(Core)(Disk 3 of 4).ssd',
    'Dragonstone (1994)(Core)(Disk 4 of 4).ssd',
    'Dragonstone (1995)(Core)(Disk 1 of 5).ssd',
    'Dragonstone (1995)(Core)(Disk 2 of 5).ssd',
  ])
  assert.deepEqual(complete.incomplete, [])
  assert.equal(complete.included.length, 4)

  // But a set that really is short of a disc still says so.
  const short = scan([
    'Citadel, The (1989)(Superior)(Disk 1 of 5).ssd',
    'Citadel, The (1989)(Superior)(Disk 3 of 5).ssd',
    'Citadel, The (1989)(Superior)(Disk 4 of 5).ssd',
    'Citadel, The (1989)(Superior)(Disk 5 of 5).ssd',
  ])
  assert.deepEqual(short.incomplete, [{ title: 'Citadel, The', missing: ['D2'] }])

  // And so does one where only the first disc of three was ever kept.
  const lonely = scan(['Wheels of Fire (1991)(Domark)(Disk 1 of 3).ssd'])
  assert.deepEqual(lonely.incomplete, [{ title: 'Wheels of Fire', missing: ['D2', 'D3'] }])
})

check('every dimension of the filter is asked, and says why', () => {
  const accepted = ['.ssd']
  const reason = (name: string, filter: ScanFilter = CLEAN_RELEASES) => {
    const verdict = judge(media(name), readTags(name), filter, accepted)
    return verdict.included ? undefined : verdict.reason
  }

  assert.equal(reason('Elite (1984).ssd'), undefined)
  assert.equal(reason('Elite (1984)[b].ssd'), 'marked bad')
  assert.equal(reason('Elite (1984)(proto).ssd'), 'a prototype build')
  assert.equal(reason('Elite (1984).adf'), 'a format this drive cannot load')

  const english: ScanFilter = {
    ...CLEAN_RELEASES,
    languages: { include: ['en'], includeUntagged: false },
  }
  assert.equal(reason('Elite (1984)(de).ssd', english), 'in de')
  assert.equal(reason('Elite (1984)(en).ssd', english), undefined)
  assert.equal(reason('Elite (1984).ssd', english), 'states no language')
  assert.equal(
    reason('Elite (1984).ssd', {
      ...english,
      languages: { include: ['en'], includeUntagged: true },
    }),
    undefined,
  )

  // A build that was asked for is not a reason to leave anything out.
  assert.equal(reason('Elite (1984)(proto).ssd', { ...CLEAN_RELEASES, devStatus: ['prototype'] }), undefined)
})

check('a scan reports where everything would land, and what it left behind', () => {
  const plan = planBulkAdd(
    [
      { ...media('Elite (1984).ssd'), category: 'games' },
      { ...media('View (1983).ssd'), category: 'applications' },
      { ...media('Nothing (1984)[b].ssd'), category: 'games' },
      media('Unknown (1984).ssd'),
    ],
    { ...bbcProfile, folderLayout: 'category', naming: 'title' },
    'bbc',
    CLEAN_RELEASES,
  )

  assert.equal(plan.considered, 4)
  assert.equal(plan.included.length, 3)
  assert.deepEqual(
    plan.byFolder.map((group) => group.folder),
    ['Apps', 'Games', UNCATEGORISED],
  )
  assert.equal(plan.unsorted.length, 1)
  assert.deepEqual(
    plan.excluded.map((group) => group.reason),
    ['marked bad'],
  )
  assert.equal(plan.totalBytes, plan.included.reduce((total, item) => total + item.size, 0))
})

check('a scan never offers a disc this profile already holds', () => {
  const item = media('Elite (1984).ssd')
  const plan = planBulkAdd([item], scanProfile, 'bbc', CLEAN_RELEASES, { staged: [item] })

  assert.deepEqual(plan.included, [])
  assert.equal(plan.excluded[0].count, 1)

  // And not merely the same row: a *different* release of a disc already held
  // is the same disc, and adding it beside the first is how a profile added to
  // twice ended up with several copies of one application.
  const alreadyHeld = media('3-D Professional (1990)(ASDG)(Disk 4 of 6).ssd')
  const anotherCopy = {
    ...media('3-D Professional (1990)(ASDG)(Disk 4 of 6)[a].ssd'),
    id: 'another',
    path: '/library/elsewhere/3-D Professional (1990)(ASDG)(Disk 4 of 6)[a].ssd',
  }
  const second = planBulkAdd([anotherCopy], scanProfile, 'bbc', CLEAN_RELEASES, {
    staged: [alreadyHeld],
  })

  assert.deepEqual(second.included, [])
  assert.equal(second.excluded[0].reason, REASONS.duplicate)
})

check('every preset is a filter a scan can actually run', () => {
  const names = [
    'Elite (1984).ssd',
    'Elite (1984)[a].ssd',
    'Zool (1992)(demo).ssd',
    'Broken (1984)[b].ssd',
  ]
  for (const preset of SCAN_PRESETS) {
    const plan = scan(names, preset.filter)
    assert.ok(plan.considered === 4, preset.id)
    assert.ok(plan.included.length <= 4, preset.id)
  }
  // The default keeps one clean copy and nothing else.
  assert.deepEqual(written(names), ['Elite (1984).ssd'])
  // Everything means everything, including both copies of the same title.
  const everything = SCAN_PRESETS.find((preset) => preset.id === 'everything')!
  assert.equal(scan(names, everything.filter).included.length, 4)
})

check('a library of a few thousand titles is planned in a moment', () => {
  const many = Array.from({ length: 1500 }, (_, index) => [
    media(`Title ${index} (1984)(Acornsoft)(Disk 1 of 2).ssd`),
    media(`Title ${index} (1984)(Acornsoft)(Disk 2 of 2).ssd`),
  ]).flat()
  const started = Date.now()
  const plan = planBulkAdd(many, scanProfile, 'bbc', CLEAN_RELEASES)

  assert.equal(plan.included.length, 3000)
  assert.ok(
    Date.now() - started < 4000,
    `planning 3000 titles took ${Date.now() - started}ms`,
  )
})

check('a naming rule always has a name to show for itself', () => {
  for (const naming of ['title', 'oled', 'original'] as const) {
    assert.equal(namingChoice(naming).id, naming)
    assert.ok(namingChoice(naming).summary.length > 20)
  }
})

check('a collection that names its folders after its catalogue still reads', () => {
  // Real collections name folders after their own dat files rather than after
  // the word alone. Requiring the segment to *be* the word left every one of
  // these unsorted, and a whole TOSEC tree with it.
  const source = '/library/TOSEC'
  assert.equal(
    inferCategoryId(`${source}/Commodore Amiga - Games - [ADF]/Elite.adf`, source),
    'games',
  )
  assert.equal(
    inferCategoryId(`${source}/Acorn BBC Micro - Applications - [SSD]/View.ssd`, source),
    'applications',
  )
  assert.equal(
    inferCategoryId(`${source}/Sinclair ZX Spectrum - Demos/Shock.trd`, source),
    'demos',
  )
  assert.equal(
    inferCategoryId(`${source}/Amstrad CPC - Magazines - [DSK]/Amstrad Action.dsk`, source),
    'magazines',
  )

  // Still whole words, or every game show would be a game.
  assert.equal(inferCategoryId(`${source}/Gameshow Collection/Quiz.adf`, source), undefined)
  assert.equal(inferCategoryId(`${source}/Demolition/Man.adf`, source), undefined)
})

check('the source folder itself is read, but only as a last resort', () => {
  // Somebody who points this at a folder called Games has said what is in it.
  // Ignoring that left ninety-four per cent of a real library unsorted: every
  // title of a four thousand image set under ".../Commodore Amiga/Games", and
  // a TOSEC applications set with it, because the only folder that said
  // anything was the one folder that was not read.
  const games = '/library/Gamebase/Commodore/Commodore Amiga/Games'
  assert.equal(categoryFromSource(games), 'games')
  assert.equal(inferCategory(`${games}/A-Train_Disk1.adf`, games), 'games')

  const apps = '/library/TOSEC/Commodore/Amiga/Applications/[ADF]/(2022-12-21)'
  assert.equal(inferCategory(`${apps}/Deluxe Paint v1.0 (1985)(EA).adf`, apps), 'applications')

  // Still the weakest evidence there is. A folder below the root that says
  // something else is believed over it, and so is the title's own name.
  assert.equal(inferCategory(`${games}/Magazines/Zzap 1.adf`, games), 'magazines')
  assert.equal(
    inferCategory(`${games}/Amiga Format coverdisk.adf`, games, 'Amiga Format coverdisk.adf'),
    'magazines',
  )

  // A source that names nothing still leaves its titles unsorted rather than
  // inventing a category for them.
  const plain = '/library/My Stuff'
  assert.equal(categoryFromSource(plain), undefined)
  assert.equal(inferCategory(`${plain}/Elite.adf`, plain), undefined)
})

check('what the user called a source is read when its path says nothing', () => {
  // A collection kept at ".../Ghostware Collection/Commodore/Amiga" says
  // nothing about what is in it, and the folders below it say nothing either —
  // the files sit straight in the root. The person who added it called it
  // "Games (Ghostware)" and meant it, and that was seven thousand titles left
  // unsorted for want of reading the one label that answered.
  const source = {
    path: '/library/Ghostware Collection/Commodore/Amiga',
    name: 'Games (Ghostware)',
  }
  assert.equal(inferCategoryFor(`${source.path}/1 Across 2 Down_Disk1.adf`, source), 'games')

  // Still the last word, after everything about the title itself.
  assert.equal(
    inferCategoryFor(`${source.path}/Demos/Desert Dream.adf`, source),
    'demos',
  )
  // And a source whose name says nothing leaves its titles unsorted.
  assert.equal(
    inferCategoryFor(`${source.path}/Elite.adf`, { ...source, name: 'Ghostware' }),
    undefined,
  )
})

check('a bracketed demo is a build, not a demoscene production', () => {
  // In a collection's naming convention `(demo)` is a development status — a
  // playable demo of a commercial game — and filing every one of those under
  // Demos alongside the demoscene work is exactly the sort of silent mistake
  // that a few thousand titles turns into an afternoon's work.
  assert.equal(inferCategoryFromName('Turrican II (1991)(Rainbow Arts)(demo).adf'), undefined)
  assert.equal(inferCategoryFromName('Zool (1992)(Gremlin)(demo-playable).adf'), undefined)

  // Said outright, rather than in brackets, it still means what it says.
  assert.equal(inferCategoryFromName('Desert Dream demo.adf'), 'demos')
  const source = '/library/TOSEC/Amiga'
  assert.equal(inferCategory(`${source}/Demos/Enigma (1991)(demo).adf`, source), 'demos')
})

check("a destination's own folder names are used rather than ours", () => {
  // A stick that calls its applications folder `Applications` has to keep being
  // written to `Applications`. Writing `Apps` beside it makes a second folder
  // and every title in it reports as filed somewhere unexpected.
  const listing = [
    { name: 'Applications', path: '/media/gotek/Applications', extension: '', size: 0, directory: true },
    { name: 'Games', path: '/media/gotek/Games', extension: '', size: 0, directory: true },
    { name: 'Demos', path: '/media/gotek/Demos', extension: '', size: 0, directory: true },
    { name: 'Elite.ssd', path: '/media/gotek/Elite.ssd', extension: 'ssd', size: 1, directory: false },
  ]
  const found = destinationCategoryFolders(listing)

  // Only what differs from the name this application would choose: an override
  // saying the same thing as the default is noise.
  assert.deepEqual(found, { applications: 'Applications' })

  const profile: Profile = { ...bbcProfile, folderLayout: 'category', categoryFolders: found }
  assert.equal(categoryFolderFor(profile, 'applications'), 'Applications')
  assert.equal(categoryFolderFor(profile, 'games'), 'Games')
  // Nothing discovered means the canonical name, and no category means the
  // bucket everything unsorted shares.
  assert.equal(categoryFolderFor(undefined, 'applications'), 'Apps')
  assert.equal(categoryFolderFor(profile, undefined), UNCATEGORISED)

  const item: MediaItem = { ...media('View (1983).ssd'), category: 'applications' }
  const [operation] = transferOperations([item], profile)
  assert.equal(operation.relativePath, 'Applications/View.ssd')
  // And through a custom template, which is the same decision spelled out.
  const [templated] = transferOperations([item], {
    ...profile,
    folderLayout: 'custom',
    folderTemplate: '{platform}/{category}',
  })
  assert.equal(templated.relativePath, 'BBC/Applications/View.ssd')
})

check("an archive's own name says what its contents are and what they are called", () => {
  // A single-title archive carries the tags; the file inside is often just
  // `disk1.adf`, which says nothing at all.
  const inside = classifyMedia(
    {
      name: 'disk1.adf',
      path: '/library/Games/Dungeon Master (1987)(FTL).zip!/disk1.adf',
      extension: 'adf',
      size: 901120,
      directory: false,
    },
    '/library',
  )
  assert.equal(inside.category, 'games')
  assert.equal(releaseName({ ...inside, assignedPlatformId: 'amiga' }), 'Dungeon Master.adf')
})

check('every category has a folder name a two-line display can show', () => {
  for (const category of categories) {
    assert.ok(category.folderName.length <= 8, `${category.name} is too long for a display`)
    assert.ok(category.hints.length > 0, `${category.name} can never be inferred`)
  }
  const ids = categories.map((category) => category.id)
  assert.equal(new Set(ids).size, ids.length, 'category ids repeat')
  // An uncategorised title still needs somewhere to go.
  assert.equal(categoryFolder(undefined), UNCATEGORISED)
  assert.equal(categoryFolder('games'), 'Games')
})

// ---------------------------------------------------------------------------
// Copying a destination onto a stick
// ---------------------------------------------------------------------------

function held(relativePath: string, size = 901120): HeldFile {
  return { source: `/master/${relativePath}`, relativePath, size }
}

check('a stick is measured in clusters, because that is what it charges', () => {
  // The number that decides whether a collection fits. An 881 KB disk image on
  // a 32 KB cluster occupies 896 KB, and ten thousand of them turn a
  // comfortable byte total into an overflowing one.
  const files = [held('Games/Elite.adf', 901120), held('Games/Zool.adf', 901120)]

  assert.equal(costOf(files, 0), 1802240, 'with no clusters it is just the bytes')
  assert.equal(costOf(files, 32768), 2 * 917504, 'each rounds up to a whole cluster')
  assert.ok(costOf(files, 32768) > 1802240, 'and that is more than the bytes')

  // A file that lands exactly on a boundary is not charged an extra one.
  assert.equal(costOf([held('Games/Exact.adf', 65536)], 32768), 65536)
})

check('unticking a folder leaves everything inside it out', () => {
  const files = [
    held('Games/Elite.adf'),
    held('Games/Deep/Zool.adf'),
    held('Apps/Deluxe Paint.adf'),
    held('FF.CFG', 200),
  ]

  const excluded = new Set(['Games'])
  assert.equal(isExcluded('Games/Elite.adf', excluded), true)
  assert.equal(isExcluded('Games/Deep/Zool.adf', excluded), true, 'however deep it is')
  assert.equal(isExcluded('Apps/Deluxe Paint.adf', excluded), false)

  assert.deepEqual(
    keptFiles(files, excluded).map((file) => file.relativePath),
    ['Apps/Deluxe Paint.adf', 'FF.CFG'],
  )

  // The tree carries the totals a picker shows, folders first.
  const tree = treeOf(files)
  assert.deepEqual(tree.map((node) => node.name), ['Apps', 'Games', 'FF.CFG'])
  const games = tree.find((node) => node.name === 'Games')!
  assert.equal(games.files, 2, 'counts everything beneath it')
  assert.equal(games.size, 901120 * 2)
})

check('the discs of one title are left out together, never singly', () => {
  // A game missing a disc is dead weight, so dropping any disc drops its set.
  assert.equal(titleOf('Games/Elite D1.adf'), titleOf('Games/Elite D2.adf'))
  assert.notEqual(titleOf('Games/Elite D1.adf'), titleOf('Games/Zool D1.adf'))
  // The folder is part of it: two games of one name under different categories
  // are not the same title.
  assert.notEqual(titleOf('Games/Elite.adf'), titleOf('Apps/Elite.adf'))
})

check('setup and system disks are recognised on whole words only', () => {
  assert.equal(looksLikeSetup('Apps/Workbench 3.1.adf'), true)
  assert.equal(looksLikeSetup('Apps/Install Disk.adf'), true)
  assert.equal(looksLikeSetup('System/Kickstart 1.3.adf'), true)
  // And a title that merely contains one of those letters is not.
  assert.equal(looksLikeSetup('Games/Preinstalled Hero.adf'), false)
  assert.equal(looksLikeSetup('Games/Bootleg Racer.adf'), false)
})

check('the automatic proposal stops as soon as it fits, and says what it did', () => {
  const profile: Profile = { ...bbcProfile, platformId: 'amiga', folderLayout: 'category' }
  const files = [
    held('Games/Elite D1.adf'),
    held('Games/Elite D2.adf'),
    held('Apps/Workbench 3.1.adf'),
    held('Apps/Deluxe Paint.adf'),
    held('Games/Notes.txt', 500),
    held('FF.CFG', 200),
  ]
  const capacity = { usableBytes: 4 * 917504, clusterBytes: 32768 }

  const proposal = proposeExclusions(files, profile, capacity)

  assert.ok(proposal.fits, 'it made room')
  assert.ok(proposal.steps.length > 0, 'and said what it did')
  // A format the drive cannot load goes first; the drive's own configuration
  // never does, because without it the stick will not behave.
  assert.equal(isExcluded('Games/Notes.txt', proposal.excluded), true)
  assert.equal(isExcluded('FF.CFG', proposal.excluded), false)

  // Where a disc of a set is dropped, the whole set goes with it.
  const elite = ['Games/Elite D1.adf', 'Games/Elite D2.adf']
    .map((path) => isExcluded(path, proposal.excluded))
  assert.equal(new Set(elite).size, 1, 'both discs, or neither')
})

check('a proposal gives up whole categories, least wanted first, until it fits', () => {
  // Stopping after the setup disks and announcing that it does not fit is not
  // help: the point of asking is to be handed something that fits, and a
  // category is the largest thing that can go without breaking anything.
  const profile: Profile = { ...bbcProfile, platformId: 'amiga', folderLayout: 'category' }
  const files = [
    held('Games/Elite.adf'),
    held('Apps/Deluxe Paint.adf'),
    held('Mags/Amiga Format 1.adf'),
    held('System/Workbench.adf'),
  ]
  // Room for one title only, so everything but the games has to go.
  const proposal = proposeExclusions(files, profile, {
    usableBytes: 917504,
    clusterBytes: 32768,
  })

  assert.ok(proposal.fits)
  assert.deepEqual(
    keptFiles(files, proposal.excluded).map((file) => file.relativePath),
    ['Games/Elite.adf'],
    'games are what the stick is for, so they are the last thing given up',
  )
  assert.ok(
    proposal.steps.some((step) => step.includes('Mags')),
    'and it says which categories it gave up',
  )
})

check('a proposal that cannot make room says so rather than emptying the stick', () => {
  const profile: Profile = { ...bbcProfile, platformId: 'amiga' }
  const files = [held('Games/Elite.adf'), held('Games/Zool.adf')]
  // Room for nothing at all.
  const proposal = proposeExclusions(files, profile, { usableBytes: 1024, clusterBytes: 32768 })

  assert.equal(proposal.fits, false)
  assert.ok(
    keptFiles(files, proposal.excluded).length > 0 || proposal.steps.length > 0,
    'it reports rather than pruning on its own judgement',
  )
})

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

const CACHE = '/home/x/.cache/uk.co.gotekmanager.desktop/online-library/downloads'

check('a cached download belongs to the site it came from', () => {
  assert.equal(
    downloadSourceOf(`${CACHE}/site-1788/https___example.com_dl.php_id_AAA/images/Elite.adf`),
    `${CACHE}/site-1788`,
  )
  // The site folder itself is already where it belongs.
  assert.equal(downloadSourceOf(`${CACHE}/site-1788`), `${CACHE}/site-1788`)
  // A folder the user chose is not a download and is never moved.
  assert.equal(downloadSourceOf('/library/Amiga/Games'), undefined)
})

check('downloads are gathered under one source per site, not one per title', () => {
  // What a library built up before this looks like: a source per download,
  // each holding a single title, filling the list meant for chosen folders.
  const sources = [
    { id: 'source:/library/Amiga', name: 'Amiga', path: '/library/Amiga' },
    ...['AAA', 'BBB', 'CCC'].map((id) => ({
      id: `source:${CACHE}/site-1788/dl_${id}`,
      name: 'Amiga 500 Archive cache',
      path: `${CACHE}/site-1788/dl_${id}`,
    })),
    {
      id: `source:${CACHE}/site-9999/dl_ZZZ`,
      name: 'Another Site cache',
      path: `${CACHE}/site-9999/dl_ZZZ`,
    },
  ]
  const items = [
    { ...classifyMedia(entry('Local.adf'), '/library/Amiga'), source: '/library/Amiga' },
    ...['AAA', 'BBB', 'CCC'].map((id) => ({
      ...classifyMedia(entry(`${id}.adf`), `${CACHE}/site-1788/dl_${id}`),
      source: `${CACHE}/site-1788/dl_${id}`,
    })),
  ]

  const grouped = groupDownloads(sources, items)

  assert.deepEqual(
    grouped.sources.map((source) => source.path),
    ['/library/Amiga', `${CACHE}/site-1788`, `${CACHE}/site-9999`],
  )
  // Named for the site, without the wording that suited a single download.
  assert.equal(grouped.sources[1].name, 'Amiga 500 Archive')
  // Every title moved to its site, and none was lost on the way.
  assert.equal(grouped.items.length, items.length)
  assert.equal(
    grouped.items.filter((item) => item.source === `${CACHE}/site-1788`).length,
    3,
  )
  // A chosen folder is left exactly as it was.
  assert.equal(grouped.items[0].source, '/library/Amiga')
  // Nothing to gather means nothing is rebuilt: the very same arrays come
  // back, so reading a library of chosen folders costs nothing.
  const chosen = [sources[0]]
  const held = [items[0]]
  const untouched = groupDownloads(chosen, held)
  assert.equal(untouched.sources, chosen)
  assert.equal(untouched.items, held)
})

check('a download adds to its site rather than replacing what it holds', () => {
  const site = `${CACHE}/site-1788`
  const source = { id: `source:${site}`, name: 'Amiga 500 Archive', path: site }
  const first = { ...classifyMedia(entry('First.adf'), site), source: site }
  const second = { ...classifyMedia(entry('Second.adf'), site), source: site }

  const after = workspaceReducer(
    workspaceReducer(emptyWorkspace, { type: 'itemsImported', source, items: [first] }),
    { type: 'itemsImported', source, items: [second] },
  )

  // Indexing a folder stands for everything in it; a download does not, and
  // replacing would empty the site every time a title arrived.
  assert.deepEqual(after.items.map((item) => item.name), ['First.adf', 'Second.adf'])
  assert.equal(after.sources.length, 1)
})

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

check('a version is read as its numbers, whatever the tag is dressed in', () => {
  assert.deepEqual(parseVersion('v0.2.0'), [0, 2, 0])
  assert.deepEqual(parseVersion('0.2.0'), [0, 2, 0])
  assert.deepEqual(parseVersion('0.2.0-rc1'), [0, 2, 0, 1])
  // A tag with no numbers in it is not a version, which is what stops a stray
  // tag such as "latest" being offered as a release.
  assert.deepEqual(parseVersion('latest'), [])
  assert.deepEqual(parseVersion(''), [])
})

check('one version is newer than another by number, never by spelling', () => {
  assert.equal(isNewer('v0.3.0', '0.2.0'), true)
  assert.equal(isNewer('0.2.0', '0.2.0'), false)
  assert.equal(isNewer('0.1.9', '0.2.0'), false)
  // The one that catches everybody: as text, "0.10.0" sorts before "0.9.0".
  assert.equal(isNewer('0.10.0', '0.9.0'), true)
  assert.equal(isNewer('0.9.0', '0.10.0'), false)
  assert.equal(isNewer('1.0.0', '0.99.99'), true)
  // Written with different numbers of parts, and still equal.
  assert.equal(isNewer('0.2', '0.2.0'), false)
  assert.equal(isNewer('0.2.0', '0.2'), false)
  assert.equal(isNewer('0.2.1', '0.2'), true)
  // A tag that is not a version can never be newer than what is installed.
  assert.equal(isNewer('nightly', '0.2.0'), false)
})

check('only a published release later than this one is offered', () => {
  const release = (tag: string, extra: Partial<PublishedRelease> = {}): PublishedRelease => ({
    tag,
    name: `GoTek Manager ${tag}`,
    notes: '',
    url: `https://example.org/${tag}`,
    draft: false,
    prerelease: false,
    ...extra,
  })

  assert.equal(newerRelease([release('v0.3.0')], '0.2.0')?.tag, 'v0.3.0')
  // Nothing newer, so nothing to offer.
  assert.equal(newerRelease([release('v0.2.0'), release('v0.1.0')], '0.2.0'), undefined)
  // A draft is not published, and a prerelease is something to go looking for
  // rather than be sent to.
  assert.equal(newerRelease([release('v0.4.0', { draft: true })], '0.2.0'), undefined)
  assert.equal(newerRelease([release('v0.4.0', { prerelease: true })], '0.2.0'), undefined)
  // The newest by version, not by the order the API happened to return them.
  assert.equal(
    newerRelease([release('v0.3.0'), release('v0.10.0'), release('v0.4.0')], '0.2.0')?.tag,
    'v0.10.0',
  )
  // Nothing came back at all: the question was not answered, and an empty list
  // must never read as "you are up to date".
  assert.equal(newerRelease([], '0.2.0'), undefined)
})

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

check('records helpers keep order and identity', () => {
  const list = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]
  const merged = upsertById(list, { id: 'a', n: 9 }, { id: 'c', n: 3 })

  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c'])
  assert.equal(merged[0].n, 9)
  assert.deepEqual(omitKey({ a: 1, b: 2 }, 'a'), { b: 2 })
  assert.deepEqual(countBy(['x', 'y', 'x'], (value) => value), { x: 2, y: 1 })

  // One id or a whole selection of them, so a bulk removal is a single pass.
  assert.deepEqual(removeById(list, 'a').map((item) => item.id), ['b'])
  assert.deepEqual(removeById(list, 'a', 'b'), [])
  assert.deepEqual(removeById(list), list)
})

// ---------------------------------------------------------------------------
// Multi-selection
// ---------------------------------------------------------------------------

const ticks = (selected: ReadonlySet<string>) => [...selected].sort()

check('a tick box adds a row and takes it away again', () => {
  const one = toggled(new Set<string>(), 'b')
  assert.deepEqual(ticks(one), ['b'])
  assert.deepEqual(ticks(toggled(one, 'b')), [])
  assert.deepEqual(ticks(toggled(one, 'c')), ['b', 'c'])
})

check('a whole group is ticked or cleared in one gesture', () => {
  const rows = ['a', 'b', 'c']
  assert.deepEqual(ticks(withAll(new Set(['z']), rows, true)), ['a', 'b', 'c', 'z'])
  assert.deepEqual(ticks(withAll(new Set(rows), rows, false)), [])
})

check('a shift-click covers the run between two rows, whichever way round', () => {
  const rows = ['a', 'b', 'c', 'd']
  assert.deepEqual(rangeOf(rows, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeOf(rows, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(rangeOf(rows, 'a', 'a'), ['a'])
  // A row that has been filtered away leaves no run to extend across, which is
  // better than guessing at one from a stale position.
  assert.deepEqual(rangeOf(rows, 'gone', 'c'), [])
})

check('ticks on rows a filter has hidden are dropped, not acted on invisibly', () => {
  const selected = new Set(['a', 'b', 'c'])

  assert.deepEqual(ticks(retained(selected, ['a', 'c'])), ['a', 'c'])
  // Nothing dropped means the very same set, so a component can compare by
  // identity rather than re-rendering on every keystroke.
  assert.equal(retained(selected, ['a', 'b', 'c', 'd']), selected)
  assert.equal(retained(new Set(), []).size, 0)
})

check('the header tick box reports none, some, or all of what is shown', () => {
  const rows = ['a', 'b']
  assert.equal(coverageOf(new Set(), rows), 'none')
  assert.equal(coverageOf(new Set(['a']), rows), 'some')
  assert.equal(coverageOf(new Set(['a', 'b']), rows), 'all')
  // Rows that are ticked but no longer listed must not read as full coverage.
  assert.equal(coverageOf(new Set(['a', 'b', 'z']), rows), 'all')
  assert.equal(coverageOf(new Set(['z']), rows), 'none')
  assert.equal(coverageOf(new Set(['a']), []), 'none')
})

// ---------------------------------------------------------------------------
// Workspace reducer
// ---------------------------------------------------------------------------

function workspaceWith(profile: Profile, items: MediaItem[]): Workspace {
  return {
    ...emptyWorkspace,
    profiles: [profile],
    activeProfileId: profile.id,
    items,
    sources: [{ id: 'source:/library', name: 'library', path: '/library' }],
    collections: { [profile.id]: items },
  }
}

check('setting and clearing an alias reaches the library and every collection', () => {
  const item = classifyMedia(entry('Elite.ssd'), '/library')
  const before = workspaceWith(bbcProfile, [item])

  const named = workspaceReducer(before, {
    type: 'displayTitleSet',
    itemId: item.id,
    displayTitle: 'ELITE',
  })
  assert.equal(named.items[0].displayTitle, 'ELITE')
  assert.equal(named.collections[bbcProfile.id][0].displayTitle, 'ELITE')

  const cleared = workspaceReducer(named, {
    type: 'displayTitleSet',
    itemId: item.id,
    displayTitle: '',
  })
  assert.equal(cleared.items[0].displayTitle, undefined)
})

check('a selection of titles leaves a collection in one pass', () => {
  const elite = classifyMedia(entry('Elite.ssd'), '/library')
  const repton = classifyMedia(entry('Repton.ssd'), '/library')
  const chuckie = classifyMedia(entry('Chuckie.ssd'), '/library')
  const before = workspaceWith(bbcProfile, [elite, repton, chuckie])

  const after = workspaceReducer(before, {
    type: 'collectionRemoved',
    profileId: bbcProfile.id,
    itemIds: [elite.id, chuckie.id],
  })

  // Taken out of the profile, but still in the library to be added again.
  assert.deepEqual(after.collections[bbcProfile.id].map((item) => item.name), ['Repton.ssd'])
  assert.equal(after.items.length, 3)
})

check('a platform is assigned to a whole selection at once', () => {
  const first = classifyMedia(entry('Sorcery.dsk'), '/library')
  const second = classifyMedia(entry('Roland.dsk'), '/library')
  const before = workspaceWith(bbcProfile, [first, second])

  const after = workspaceReducer(before, {
    type: 'platformAssigned',
    itemIds: [first.id, second.id],
    platformId: 'cpc464',
  })

  assert.deepEqual(
    after.items.map((item) => item.assignedPlatformId),
    ['cpc464', 'cpc464'],
  )
  assert.deepEqual(
    after.collections[bbcProfile.id].map((item) => item.assignedPlatformId),
    ['cpc464', 'cpc464'],
  )
})

check('a profile id follows its destination so collections survive a restart', () => {
  assert.equal(profileIdFor({ kind: 'folder', path: '/media/gotek' }), 'profile:/media/gotek')
  // The same path discovered as a volume is the same profile, not a second one.
  assert.equal(
    profileIdFor({ kind: 'volume', path: '/media/gotek' }),
    profileIdFor({ kind: 'folder', path: '/media/gotek' }),
  )
  const created = createProfile({ kind: 'volume', path: '/media/AMIGA' }, {
    firmwareId: 'hxc',
    organise: true,
    folderLayout: 'flat',
    naming: 'original',
  })
  assert.equal(created.id, 'profile:/media/AMIGA')
  assert.equal(created.platformId, 'amiga')
  assert.equal(created.firmwareId, 'hxc')
})

check('firmware found on the media beats the configured default', () => {
  const created = createProfile(
    { kind: 'volume', path: '/media/GOTEK', detectedFirmwareId: 'hxc' },
    { firmwareId: 'flashfloppy', organise: true, folderLayout: 'flat', naming: 'oled' },
  )
  assert.equal(created.firmwareId, 'hxc')
})

check('assigning a platform updates the library and every collection', () => {
  const item = classifyMedia(entry('Sorcery.dsk'), '/library')
  const before = workspaceWith(bbcProfile, [item])

  const after = workspaceReducer(before, {
    type: 'platformAssigned',
    itemIds: [item.id],
    platformId: 'cpc464',
  })

  assert.equal(after.items[0].assignedPlatformId, 'cpc464')
  assert.equal(after.collections[bbcProfile.id][0].assignedPlatformId, 'cpc464')
})

check('a category is set for a whole selection and can be cleared again', () => {
  const first = classifyMedia(entry('Elite.ssd'), '/library')
  const second = classifyMedia(entry('Repton.ssd'), '/library')
  const before = workspaceWith(bbcProfile, [first, second])

  const sorted = workspaceReducer(before, {
    type: 'categoryAssigned',
    itemIds: [first.id, second.id],
    categoryId: 'games',
  })
  assert.deepEqual(sorted.items.map((item) => item.category), ['games', 'games'])
  // The staged copies are the same titles and must not disagree with the library.
  assert.deepEqual(
    sorted.collections[bbcProfile.id].map((item) => item.category),
    ['games', 'games'],
  )

  const cleared = workspaceReducer(sorted, {
    type: 'categoryAssigned',
    itemIds: [first.id],
    categoryId: '',
  })
  assert.deepEqual(cleared.items.map((item) => item.category), [undefined, 'games'])
})

check('removing a source purges its titles from the library and collections', () => {
  const mine = classifyMedia(entry('Elite.ssd'), '/library')
  const other: MediaItem = { ...classifyMedia(entry('Repton.ssd'), '/other'), source: '/other' }
  const before = workspaceWith(bbcProfile, [mine, other])

  const after = workspaceReducer(before, {
    type: 'sourceRemoved',
    source: { id: 'source:/library', name: 'library', path: '/library' },
  })

  assert.deepEqual(after.items.map((item) => item.name), ['Repton.ssd'])
  assert.deepEqual(after.collections[bbcProfile.id].map((item) => item.name), ['Repton.ssd'])
  assert.equal(after.sources.length, 0)
})

check('re-indexing a source drops titles whose files have gone', () => {
  const kept = classifyMedia(entry('Elite.ssd'), '/library')
  const deleted = classifyMedia(entry('Deleted.ssd'), '/library')
  const before = workspaceWith(bbcProfile, [kept, deleted])

  const after = workspaceReducer(before, {
    type: 'sourceIndexed',
    source: { id: 'source:/library', name: 'library', path: '/library' },
    items: [kept],
  })

  assert.deepEqual(after.items.map((item) => item.name), ['Elite.ssd'])
  assert.deepEqual(after.collections[bbcProfile.id].map((item) => item.name), ['Elite.ssd'])
})

check('removing a profile discards its collection and reselects another', () => {
  const second: Profile = { ...bbcProfile, id: 'profile:/media/two', name: 'Two' }
  const before: Workspace = {
    ...workspaceWith(bbcProfile, []),
    profiles: [bbcProfile, second],
  }

  const after = workspaceReducer(before, { type: 'profileRemoved', id: bbcProfile.id })

  assert.deepEqual(after.profiles.map((profile) => profile.id), [second.id])
  assert.equal(after.activeProfileId, second.id)
  assert.equal(Object.hasOwn(after.collections, bbcProfile.id), false)
})

check('choosing mounts drafts only the destinations not already registered', () => {
  const defaults = {
    firmwareId: 'flashfloppy',
    organise: true,
    folderLayout: 'flat' as const,
    naming: 'oled' as const,
  }
  const mount = (path: string, label: string) => ({
    path,
    device: '/dev/sdb1',
    label,
    filesystem: 'vfat',
    kind: 'removable' as const,
    removable: true,
  })

  const drafted = profilesForMounts(
    [mount('/media/gotek', 'GOTEK'), mount('/media/NEW', 'NEW')],
    defaults,
    [bbcProfile],
  )

  // The registered destination is left alone: it keeps its own settings and
  // whatever it has staged, rather than being offered back as a new profile.
  assert.deepEqual(drafted.map((profile) => profile.id), ['profile:/media/NEW'])
  assert.equal(drafted[0].name, 'NEW')
  assert.equal(drafted[0].folderLayout, 'flat')
})

check('an empty collection keeps a stable identity so planning cannot loop', () => {
  const workspace = emptyWorkspace
  assert.equal(collectionOf(workspace, 'missing'), collectionOf(workspace, 'other'))
})

check('image destinations are never writable', () => {
  assert.equal(isWritable(bbcProfile), true)
  assert.equal(
    isWritable({ ...bbcProfile, destination: { kind: 'image', path: '/i.img' } }),
    false,
  )
  assert.equal(isWritable(undefined), false)
})

// ---------------------------------------------------------------------------
// Migration from the pre-2.0 layout
// ---------------------------------------------------------------------------

check('the previous storage layout becomes one workspace', () => {
  storage.clear()
  storage.setItem(
    'gm.settings',
    JSON.stringify({
      theme: 'dark',
      organise: false,
      naming: 'original',
      folderLayout: 'flat',
      firmwareId: 'hxc',
    }),
  )
  storage.setItem(
    'gm.targets',
    JSON.stringify([
      { id: 'folder:/media/gotek', name: 'GOTEK', kind: 'Folder', path: '/media/gotek' },
      {
        id: '/dev/sdb1:/media/usb',
        name: 'USB',
        kind: 'USB',
        path: '/media/usb',
        discovered: true,
        device: '/dev/sdb1',
      },
      { id: 'image:/images/disk.img', name: 'disk.img', kind: 'Image', path: '/images/disk.img' },
    ]),
  )
  storage.setItem(
    'gm.profiles',
    JSON.stringify([
      {
        id: 'profile-setup-folder:/media/gotek',
        name: 'GOTEK',
        platformId: 'c64',
        firmwareId: 'flashfloppy',
        organise: true,
        naming: 'oled',
        folderLayout: 'platform',
      },
    ]),
  )
  storage.setItem(
    'gm.setupQueues',
    JSON.stringify({
      'folder:/media/gotek': [
        {
          id: '/library/Elite.ssd',
          path: '/library/Elite.ssd',
          name: 'Elite.ssd',
          extension: 'ssd',
          size: 200,
          directory: false,
          source: '/library',
          platformIds: ['bbc'],
        },
      ],
    }),
  )
  storage.setItem('gm.setupMatchModes', JSON.stringify({ 'folder:/media/gotek': true }))
  storage.setItem('gm.selectedTarget', JSON.stringify('image:/images/disk.img'))
  storage.setItem('gm.sources', JSON.stringify(['/library']))

  const settings = loadSettings()
  const workspace = loadWorkspace()

  assert.equal(settings.theme, 'dark')
  assert.equal(settings.defaults.firmwareId, 'hxc')
  assert.equal(settings.defaults.organise, false)

  assert.deepEqual(workspace.profiles.map((profile) => profile.id), [
    'profile:/media/gotek',
    'profile:/media/usb',
    'profile:/images/disk.img',
  ])
  // The paired settings record wins over the global defaults.
  const gotek = workspace.profiles[0]
  assert.equal(gotek.platformId, 'c64')
  assert.equal(gotek.folderLayout, 'platform')
  // A target with no paired record falls back to the migrated defaults.
  assert.equal(workspace.profiles[1].folderLayout, 'flat')
  assert.equal(workspace.profiles[1].destination.removable, true)
  assert.equal(workspace.profiles[2].destination.kind, 'image')

  assert.equal(workspace.activeProfileId, 'profile:/images/disk.img')
  assert.equal(workspace.collections['profile:/media/gotek'].length, 1)
  // Legacy items stored platformIds under the old name.
  assert.deepEqual(workspace.collections['profile:/media/gotek'][0].likelyPlatformIds, ['bbc'])
  assert.equal(workspace.removalPolicies['profile:/media/gotek'], 'remove')
  assert.deepEqual(workspace.sources, [
    { id: 'source:/library', name: 'library', path: '/library' },
  ])
})

check('a change to a shipped source overrides it and can be put back', () => {
  const shipped = defaultProviders.filter((provider) => provider.adapter === 'htmlSite')
  const target = shipped[0]
  // The case that could not be expressed at all before: turning off robots for
  // a site that shipped, without adding a second copy of it by hand.
  const changed = { ...target, ignoreRobots: true }
  const own = {
    id: 'site-1',
    name: 'My list',
    adapter: 'jsonFeed' as const,
    catalogUrl: 'https://example.org/list.json',
  }

  const merged = mergeProviders(shipped, [changed, own])
  const found = merged.find((provider) => provider.id === target.id)

  // One entry, not two, and it knows it is a shipped source that was changed.
  assert.equal(merged.filter((provider) => provider.id === target.id).length, 1)
  assert.equal(found?.ignoreRobots, true)
  assert.equal(found?.builtIn, true)
  assert.equal(found?.overridden, true)

  // The user's own source is neither, so it is offered removal rather than
  // restoration.
  const mine = merged.find((provider) => provider.id === 'site-1')
  assert.equal(mine?.builtIn, false)
  assert.equal(mine?.overridden, false)

  // Dropping the override is what restores the shipped settings.
  const restored = mergeProviders(shipped, [own])
  assert.equal(
    restored.find((provider) => provider.id === target.id)?.ignoreRobots,
    undefined,
  )
})

check('the edit dialog and the source file reject the same things', () => {
  // One check, so a source typed into the dialog and one written into the file
  // cannot disagree about what is valid.
  assert.equal(
    faultIn({ id: 'x', name: 'X', adapter: 'htmlSite', platformId: 'bbc' }, 'This site'),
    'This site needs an https:// URL',
  )
  assert.equal(
    faultIn({ id: 'x', name: 'X', adapter: 'demozoo', query: '66', platformId: 'bbc' }, 'This site'),
    null,
  )
  assert.equal(
    faultIn({ id: 'x', name: 'X', adapter: 'demozoo', query: 'bbc', platformId: 'bbc' }, 'This site'),
    'This site needs a Demozoo platform number in its query',
  )
  assert.equal(
    faultIn(
      { id: 'x', name: 'X', adapter: 'htmlSite', catalogUrl: 'https://example.org/' },
      'This site',
    ),
    'This site does not say which machine it is for',
  )
  assert.equal(
    faultIn(
      {
        id: 'x',
        name: 'X',
        adapter: 'htmlSite',
        platformId: 'bbc',
        catalogUrl: 'https://example.org/',
      },
      'This site',
    ),
    null,
  )
})

check('the drive configuration says what the firmware needs and nothing more', () => {
  const bbc = requirePlatform('bbc')
  const file = flashFloppyConfig(bbcProfile, bbc)

  // Written in the form the firmware's own example file uses.
  assert.ok(file.includes('nav-mode = native'))
  // An Acorn machine gets the two settings FlashFloppy documents for it.
  assert.ok(file.includes('host = acorn'))
  assert.ok(file.includes('index-suppression = no'))
  // The interface is never written: its default follows the JC jumper, which is
  // already correct for every machine here, and a file that overrode it would
  // stop a properly jumpered drive working.
  assert.ok(!/^interface\s*=/m.test(file))
  // Every setting is explained in the file itself.
  for (const line of file.split('\n').filter((entry) => entry.includes(' = '))) {
    assert.ok(line.trim().length > 0, 'a setting was written with no value')
  }
  assert.ok(file.endsWith('\n'))
  // Parsed by an 8-bit drive rather than a text editor, so plain ASCII only —
  // including when the profile itself is named in another script.
  const named = flashFloppyConfig({ ...bbcProfile, name: 'Ünité — “x”' }, bbc)
  assert.ok(/^[\t\x20-\x7e\n]*$/.test(named), 'the configuration is not plain ASCII')

  // A machine with no documented needs gets the navigation setting alone,
  // rather than another machine's host value.
  const cpc = flashFloppyConfig({ ...bbcProfile, platformId: 'cpc464' }, requirePlatform('cpc464'))
  assert.ok(cpc.includes('nav-mode = native'))
  assert.ok(!cpc.includes('host ='))
  assert.ok(!cpc.includes('index-suppression'))
})

check('a drive whose panel is upside down is told to rotate its view', () => {
  const bbc = requirePlatform('bbc')

  // Left to detect, nothing is written: the firmware's own default is right for
  // a drive that reads its panel correctly, and a file cannot be un-written.
  assert.ok(!/^display-type/m.test(flashFloppyConfig(bbcProfile, bbc)))
  assert.ok(!/^display-type/m.test(flashFloppyConfig({ ...bbcProfile, display: 'auto' }, bbc)))

  // The syntax FlashFloppy documents: rotation is only accepted on a named
  // panel, which is why the size is spelled out alongside it.
  const rotated = flashFloppyConfig({ ...bbcProfile, display: 'oled-128x64-rotate' }, bbc)
  assert.ok(rotated.includes('display-type = oled-128x64-rotate'))
  assert.ok(rotated.includes('upside down'), 'the reason is not explained in the file')

  const plain = flashFloppyConfig({ ...bbcProfile, display: 'oled-128x32' }, bbc)
  assert.ok(plain.includes('display-type = oled-128x32'))
  assert.ok(!plain.includes('-rotate'))

  // Every choice offered writes a value the firmware documents.
  for (const [value] of DISPLAY_CHOICES) {
    if (value === 'auto') continue
    assert.ok(
      /^oled-128x(32|64)(-rotate)?$/.test(value),
      `${value} is not a display type FlashFloppy accepts`,
    )
    assert.ok(flashFloppyConfig({ ...bbcProfile, display: value }, bbc).includes(value))
  }
})

check('a hand-tuned configuration is edited, never rewritten', () => {
  const bbc = requirePlatform('bbc')
  // The shape of a real stick's file: CRLF, settings this application has no
  // opinion about, a commented-out example, and a key assigned twice.
  const existing = [
    '# FlashFloppy configuration',
    'interface = jc',
    'image-on-startup = last',
    '',
    '## DISPLAY',
    '# display-type=oled-128x32-narrow',
    'display-type=oled-128x64',
    'oled-font = 8x16',
    'oled-contrast = 143',
    'display-order = default',
    'display-order = 3,0d,1',
    '',
  ].join('\r\n')

  const profile: Profile = { ...bbcProfile, display: 'oled-128x64-rotate' }
  const merged = mergeFlashFloppyConfig(existing, profile, bbc)

  // Everything the user tuned survives, to the byte.
  for (const line of [
    'interface = jc',
    'image-on-startup = last',
    'oled-font = 8x16',
    'oled-contrast = 143',
    'display-order = 3,0d,1',
    '## DISPLAY',
    '# display-type=oled-128x32-narrow',
  ]) {
    assert.ok(merged.includes(line), `${line} was lost`)
  }

  // The one setting that is this application's is changed where it already is,
  // keeping the line's own spacing rather than imposing a house style.
  assert.ok(merged.includes('display-type=oled-128x64-rotate'))
  assert.ok(!merged.includes('display-type=oled-128x64\r'))
  // A setting the file does not mention is appended with its reason.
  assert.ok(merged.includes('nav-mode = native'))
  assert.ok(merged.includes('host = acorn'))
  // The file's own line endings are kept: a drive reads this, not an editor.
  assert.ok(merged.includes('\r\n'))
  assert.ok(!/[^\r]\n/.test(merged), 'a bare newline was introduced into a CRLF file')
  assert.ok(merged.endsWith('\r\n'))

  // Applying it twice changes nothing further, so re-running it is safe.
  assert.equal(mergeFlashFloppyConfig(merged, profile, bbc), merged)
})

check('a file that already carries these settings is left exactly alone', () => {
  const bbc = requirePlatform('bbc')
  const written = flashFloppyConfig(bbcProfile, bbc)

  // Merging this application's own output with itself is a no-op, which is what
  // lets the panel say there is nothing to do.
  assert.equal(mergeFlashFloppyConfig(written, bbcProfile, bbc), written)
})

check('every occurrence of a setting is updated, not just the first', () => {
  const bbc = requirePlatform('bbc')
  // The firmware reads the last assignment, so a stale later line would quietly
  // undo the change.
  const existing = 'display-type = oled-128x32\nfoo = bar\ndisplay-type = oled-128x32\n'
  const merged = mergeFlashFloppyConfig(
    existing,
    { ...bbcProfile, display: 'oled-128x64-rotate' },
    bbc,
  )

  assert.equal(merged.match(/display-type = oled-128x64-rotate/g)?.length, 2)
  assert.ok(!merged.includes('oled-128x32'))
  assert.ok(merged.includes('foo = bar'))
})

check('only a firmware with a file this application can write is offered one', () => {
  assert.equal(configSupport('flashfloppy').writable, true)
  // HxC keeps a binary slot table written by its own desktop software; making
  // something plausible up would be worse than making nothing.
  assert.equal(configSupport('hxc').writable, false)
  assert.equal(configSupport('gotek-standard').writable, false)
  assert.equal(configFor({ ...bbcProfile, firmwareId: 'hxc' }, requirePlatform('bbc')), null)
  assert.ok(configFor(bbcProfile, requirePlatform('bbc'))?.includes('nav-mode'))
})

check('every icon the bundle names exists and is one a bundler can read', () => {
  // Windows needs an .ico and macOS an .icns, and neither is produced from a
  // PNG at bundle time. Their absence only shows up on those platforms, which
  // is to say in a release: the application shipped with a single 16-bit PNG
  // and no Windows or macOS build was possible at all.
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  const icons: string[] = config.bundle.icon

  assert.ok(icons.some((icon) => icon.endsWith('.ico')), 'no Windows icon')
  assert.ok(icons.some((icon) => icon.endsWith('.icns')), 'no macOS icon')
  for (const icon of icons) {
    assert.ok(existsSync(`src-tauri/${icon}`), `${icon} is named but missing`)
  }

  // The macOS bundler reads 8-bit PNGs only, and refuses a 16-bit one outright.
  // Byte 24 of the IHDR chunk is the bit depth.
  for (const icon of icons.filter((name) => name.endsWith('.png'))) {
    assert.equal(readFileSync(`src-tauri/${icon}`)[24], 8, `${icon} is not 8-bit`)
  }
})

check('a stored record is revived against the shape being read, not returned as written', () => {
  // The path the application actually takes: `usePersistentState` reads the key
  // and hands back what it finds. A record written before a setting existed
  // therefore arrives without it, and `undefined` in a checkbox reads as off
  // however the default was declared. `reviveSettings` is what closes that.
  const written = {
    theme: 'dark',
    defaults: { firmwareId: 'hxc', organise: false },
  } as unknown as ReturnType<typeof loadSettings>

  const revived = reviveSettings(written)

  assert.equal(revived.theme, 'dark')
  assert.equal(revived.convertIncompatible, true)
  // A nested default missing from the record fills in too, rather than leaving
  // a profile created from it with no naming rule at all.
  assert.equal(revived.defaults.firmwareId, 'hxc')
  assert.equal(revived.defaults.organise, false)
  assert.equal(revived.defaults.naming, 'title')
  assert.equal(revived.defaults.folderLayout, 'platform')
})

check('a settings record written before conversion existed gains the new default', () => {
  storage.clear()
  // The stored shape from a previous version: no conversion preference at all.
  // Reading it must not leave the field undefined, which would send `convert:
  // undefined` to the scanner and make the behaviour depend on a native default
  // rather than on what the settings screen shows.
  storage.setItem(
    'gm.settings.v2',
    JSON.stringify({
      theme: 'dark',
      defaults: { firmwareId: 'hxc', organise: true, folderLayout: 'flat', naming: 'oled' },
    }),
  )

  const settings = loadSettings()

  assert.equal(settings.theme, 'dark')
  assert.equal(settings.convertIncompatible, true)
})

check('a corrupt or empty store still yields a usable workspace', () => {
  storage.clear()
  storage.setItem('gm.workspace.v2', '{ this is not json')

  const workspace = loadWorkspace()

  assert.deepEqual(workspace.profiles, [])
  assert.equal(workspace.activeProfileId, '')
  assert.equal(loadSettings().theme, 'system')
})

check('an already-migrated workspace is loaded from its two slices', () => {
  storage.clear()
  const item = classifyMedia(entry('Elite.ssd'), '/library')
  const split = splitWorkspace({
    ...emptyWorkspace,
    profiles: [bbcProfile],
    activeProfileId: bbcProfile.id,
    items: [item],
    sources: [{ id: 'source:/library', name: 'library', path: '/library' }],
  })
  storage.setItem('gm.workspace.v2', JSON.stringify(split.workspace))
  storage.setItem('gm.library.v2', JSON.stringify(split.library))

  const workspace = loadWorkspace()

  assert.equal(workspace.profiles.length, 1)
  assert.equal(workspace.activeProfileId, bbcProfile.id)
  assert.equal(workspace.items.length, 1)
  assert.equal(workspace.sources.length, 1)
  // The large slice is stored apart from the small one.
  assert.equal(JSON.parse(storage.getItem('gm.workspace.v2')!).items, undefined)
})

check('changing the selection leaves the library slice untouched', () => {
  const item = classifyMedia(entry('Elite.ssd'), '/library')
  const before: Workspace = {
    ...emptyWorkspace,
    profiles: [bbcProfile, { ...bbcProfile, id: 'profile:/media/two', name: 'Two' }],
    activeProfileId: bbcProfile.id,
    items: [item],
    sources: [{ id: 'source:/library', name: 'library', path: '/library' }],
  }

  // Reference equality is what stops the persistence effect from firing, and a
  // few thousand indexed titles cost about a tenth of a second to rewrite.
  const selected = workspaceReducer(before, {
    type: 'profileSelected',
    id: 'profile:/media/two',
  })
  assert.equal(selected.items, before.items)
  assert.equal(selected.sources, before.sources)

  const staged = workspaceReducer(before, {
    type: 'collectionAdded',
    profileId: bbcProfile.id,
    items: [item],
  })
  assert.equal(staged.items, before.items)
  assert.equal(staged.sources, before.sources)

  // Re-indexing genuinely changes the library, so that slice must be rewritten.
  const indexed = workspaceReducer(before, {
    type: 'sourceIndexed',
    source: { id: 'source:/library', name: 'library', path: '/library' },
    items: [],
  })
  assert.notEqual(indexed.items, before.items)
})

check('a title too long to show has its middle taken out, never its ends', () => {
  // The publisher sits in the middle; the game is at the front and which disk
  // it is at the back. Cutting the end leaves a column of rows reading alike.
  const long = 'Another World (Delphine + U.S. Gold) A.adf'
  const shown = elideMiddle(long, 30)

  assert.ok(shown.length <= 30, shown)
  assert.ok(shown.startsWith('Another World'), shown)
  assert.ok(shown.endsWith('A.adf'), shown)
  assert.ok(shown.includes('…'), shown)

  // Two disks of a set stay distinguishable, which is the whole point.
  assert.notEqual(
    elideMiddle('Another World (Delphine + U.S. Gold) A.adf', 30),
    elideMiddle('Another World (Delphine + U.S. Gold) B.adf', 30),
  )
  // Anything that fits is left exactly as it is.
  assert.equal(elideMiddle('Zool 1 (Gremlin).adf', 44), 'Zool 1 (Gremlin).adf')
})

check('a stored column order gains a column it predates', () => {
  // The order is the user's, so it is kept; a column added to the application
  // since they last dragged one is appended rather than left invisible.
  const stored = {
    sort: { key: 'title', direction: 'desc' as const },
    columnOrder: ['title', 'presence', 'platform', 'format', 'size', 'location', 'action'],
  }

  const revived = reviveTablePreferences(stored)

  assert.ok(revived.columnOrder.includes('category'))
  assert.deepEqual(revived.columnOrder.slice(0, 2), ['title', 'presence'])
  // The row's own control stays at the end, wherever the new column landed.
  assert.equal(revived.columnOrder.at(-1), 'action')
  assert.deepEqual(revived.sort, stored.sort)
  // A column this application no longer has is dropped rather than drawn empty.
  assert.ok(
    !reviveTablePreferences({
      ...stored,
      columnOrder: [...stored.columnOrder, 'gone'],
    }).columnOrder.includes('gone'),
  )
})

// ---------------------------------------------------------------------------
// Help screenshots
// ---------------------------------------------------------------------------

check('every documented screen has an image in both palettes, and no orphans', () => {
  // This cannot tell that an image is visually stale, but it does catch a screen
  // being renamed, added, or removed without re-running `npm run screenshots`.
  for (const theme of HELP_THEMES) {
    const folder = join('public', 'help', theme)
    assert.ok(existsSync(folder), `${folder} is missing; run npm run screenshots`)

    for (const screen of ALL_HELP_SCREENS) {
      const image = join(folder, `${screen.name}.png`)
      assert.ok(existsSync(image), `${image} is missing; run npm run screenshots`)
      // A truncated capture would still exist but be tiny.
      assert.ok(statSync(image).size > 4096, `${image} looks truncated`)
    }

    const present = readdirSync(folder).filter((file) => file.endsWith('.png')).sort()
    const expected = ALL_HELP_SCREENS.map((screen) => `${screen.name}.png`).sort()
    assert.deepEqual(present, expected, `${folder} holds images no screen references`)
  }
})

// ---------------------------------------------------------------------------
// Smoke render
// ---------------------------------------------------------------------------

check('the shell renders and waits rather than showing an empty library', () => {
  storage.clear()
  const markup = renderToString(createElement(App))

  assert.ok(markup.includes('GoTek'))
  // The application opens on Profiles, because a profile is what everything
  // else is about: its folder is filled, and then written to media.
  assert.ok(markup.includes('Profiles'))
  // The workspace is read asynchronously now. Rendering "no profiles yet"
  // before it arrives would tell the user their library had vanished.
  assert.ok(markup.includes('Opening your library'))
  assert.ok(!markup.includes('No profiles yet'))
})

check('every screen is reachable from the navigation', () => {
  storage.clear()
  const markup = renderToString(createElement(App))

  for (const page of ['Library', 'Profiles', 'Devices', 'Help']) {
    assert.ok(markup.includes(`>${page}<`), `${page} is missing from the navigation`)
  }
})

// ---------------------------------------------------------------------------
// The native store
// ---------------------------------------------------------------------------

check('a workspace survives the trip to the native store and back', () => {
  const item: MediaItem = {
    ...classifyMedia(entry('Elite.ssd'), '/library'),
    assignedPlatformId: 'bbc',
    displayTitle: 'ELITE',
  }
  const before: Workspace = {
    ...emptyWorkspace,
    profiles: [
      {
        ...bbcProfile,
        verifyChecksums: true,
        folderTemplate: '{platform}/{initial}',
        display: 'oled-128x64-rotate',
        // The folder names this destination already uses have to survive with
        // the profile, or the next write makes a second set beside them.
        categoryFolders: { applications: 'Applications' },
      },
    ],
    activeProfileId: bbcProfile.id,
    collections: { [bbcProfile.id]: [item] },
    removalPolicies: { [bbcProfile.id]: 'remove' },
    sources: [{ id: 'source:/library', name: 'library', path: '/library' }],
    items: [item],
  }

  const after = forTesting.fromNative(forTesting.toNative(before))

  assert.deepEqual(after.profiles, before.profiles)
  // The drive's panel is part of the profile and has to survive the trip.
  assert.equal(after.profiles[0].display, 'oled-128x64-rotate')
  assert.equal(after.activeProfileId, before.activeProfileId)
  assert.deepEqual(after.sources, before.sources)
  assert.equal(after.items.length, 1)
  assert.equal(after.items[0].displayTitle, 'ELITE')
  assert.equal(after.collections[bbcProfile.id].length, 1)
  assert.equal(after.removalPolicies[bbcProfile.id], 'remove')
})

check('collections are stored as references, not copies of the title', () => {
  const item = classifyMedia(entry('Elite.ssd'), '/library')
  const stored = forTesting.toNative({
    ...emptyWorkspace,
    profiles: [bbcProfile, { ...bbcProfile, id: 'profile:/media/two' }],
    collections: { [bbcProfile.id]: [item], 'profile:/media/two': [item] },
    items: [item],
  })

  // One row in the library, referenced twice, rather than three copies of it.
  assert.equal(stored.items.length, 1)
  assert.deepEqual(stored.collections[bbcProfile.id], [item.id])
  assert.deepEqual(stored.collections['profile:/media/two'], [item.id])
})

check('a staged title whose file has left the library is dropped on load', () => {
  const item = classifyMedia(entry('Elite.ssd'), '/library')
  const stored = forTesting.toNative({
    ...emptyWorkspace,
    profiles: [bbcProfile],
    collections: { [bbcProfile.id]: [item] },
    items: [item],
  })
  // Simulate the title being removed from the library but its id lingering.
  stored.items = []

  const loaded = forTesting.fromNative(stored)

  // A placeholder pointing at no file would plan a copy that cannot happen.
  assert.equal(loaded.collections[bbcProfile.id], undefined)
})

check('an empty store is recognised so a migration can run', () => {
  assert.equal(forTesting.isEmpty(emptyWorkspace), true)
  assert.equal(
    forTesting.isEmpty({ ...emptyWorkspace, profiles: [bbcProfile] }),
    false,
  )
})

// ---------------------------------------------------------------------------

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
