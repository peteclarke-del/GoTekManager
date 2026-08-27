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
import { existsSync, readdirSync, statSync } from 'node:fs'
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
  platforms,
  requireFirmware,
  requirePlatform,
  supportedExtensions,
} from '../src/domain/catalog'
import {
  belongsToPlatform,
  classifyMedia,
  forProfile,
  formatBytes,
  isFirmwareCompatible,
  isOutsideProfile,
  managedFormats,
  oledName,
  outputFileName,
  outputFolder,
  renderFolderTemplate,
  softwareTitleKey,
  transferOperations,
} from '../src/domain/media'
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
import { isOnDestination, summarisePlan } from '../src/domain/plan'
import { defaultProviders, providersFor, scopeLabel } from '../src/domain/providers'
import { countBy, omitKey, upsertById } from '../src/domain/records'
import type {
  FileEntry,
  MediaItem,
  Profile,
  TransferPlan,
  TransferResultEntry,
} from '../src/domain/types'
import { loadSettings, loadWorkspace, splitWorkspace } from '../src/state/migrations'
import {
  collectionOf,
  createProfile,
  emptyWorkspace,
  isWritable,
  profileIdFor,
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

check('OLED naming trims release labels but keeps the extension', () => {
  assert.equal(oledName('Elite_(Disk 1)_1984.ssd', 24), 'Elite 1984.ssd')
  assert.equal(oledName('A Very Long Retro Game Title Indeed.ssd', 24), 'A Very Long Retro Ga.ssd')
  // Factory firmware has a much smaller display.
  assert.equal(oledName('Elite.ssd', 8).length <= 8, true)
})

check('title keys normalise enough to compare, and no further', () => {
  assert.equal(softwareTitleKey('Elite (1984) [cr].ssd'), 'elite')
  assert.equal(softwareTitleKey('/library/Chuckie Egg.ssd'), 'chuckie egg')
  assert.equal(softwareTitleKey('Dungeon Master Disk 2.adf'), 'dungeon master')
  assert.notEqual(softwareTitleKey('Elite II'), softwareTitleKey('Elite'))
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
  const item: MediaItem = {
    ...classifyMedia(entry('Elite (Disk 1).ssd'), '/library'),
    assignedPlatformId: 'bbc',
  }

  const [organised] = transferOperations([item], bbcProfile)
  assert.equal(organised.relativePath, 'BBC/Elite.ssd')

  const [flat] = transferOperations([item], { ...bbcProfile, folderLayout: 'flat' })
  assert.equal(flat.relativePath, 'Elite.ssd')

  const [original] = transferOperations([item], { ...bbcProfile, naming: 'original' })
  assert.equal(original.relativePath, 'BBC/Elite (Disk 1).ssd')

  const [unorganised] = transferOperations([item], { ...bbcProfile, organise: false })
  assert.equal(unorganised.relativePath, 'Elite.ssd')
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

  // OLED naming strips release labels such as "(disk 2)", but a year is part
  // of the title and is kept.
  assert.equal(operation.relativePath, 'BBC/E/Elite (1984).ssd')
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

  assert.equal(a.relativePath, 'CPC464/Zynaps (1987)(Hewson.dsk')
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

  // Without an alias, OLED naming applies.
  assert.equal(outputFileName(item, bbcProfile), 'Elite (1984).ssd')

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
  assert.equal(outputFileName({ ...item, displayTitle: '  ' }, bbcProfile), 'Elite (1984).ssd')
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

check('every platform has at least one online source', () => {
  for (const platform of platforms) {
    const available = providersFor(defaultProviders, platform.id)
    assert.ok(
      available.length > 0,
      `${platform.name} has no online source at all, not even the general one`,
    )
  }
})

check('a source for one machine never appears while preparing another', () => {
  const forCpc = providersFor(defaultProviders, 'cpc464').map((provider) => provider.id)

  // The BBC archives are useless here and must not be offered.
  assert.ok(!forCpc.includes('stairway-bbc'))
  assert.ok(!forCpc.includes('ia-c64'))
  assert.ok(forCpc.includes('ia-cpc464'))
  // The unscoped source applies everywhere.
  assert.ok(forCpc.includes('internet-archive'))

  const forBbc = providersFor(defaultProviders, 'bbc').map((provider) => provider.id)
  assert.ok(forBbc.includes('stairway-bbc'))
  assert.ok(!forBbc.includes('stairway-electron'))
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

check('the sidebar says what each source covers', () => {
  const name = (id: string) => requirePlatform(id).name
  const scoped = defaultProviders.find((provider) => provider.id === 'ia-cpc464')!
  const general = defaultProviders.find((provider) => provider.id === 'internet-archive')!

  assert.equal(scopeLabel(scoped, name), 'Amstrad CPC464 only')
  assert.equal(scopeLabel(general, name), 'All platforms')
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
    itemId: item.id,
    platformId: 'cpc464',
  })

  assert.equal(after.items[0].assignedPlatformId, 'cpc464')
  assert.equal(after.collections[bbcProfile.id][0].assignedPlatformId, 'cpc464')
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

check('selecting mounts adds new profiles without disturbing existing ones', () => {
  const before = workspaceWith(bbcProfile, [])
  const defaults = {
    firmwareId: 'flashfloppy',
    organise: true,
    folderLayout: 'flat' as const,
    naming: 'oled' as const,
  }

  const after = workspaceReducer(before, {
    type: 'mountsSelected',
    defaults,
    mounts: [
      {
        path: '/media/gotek',
        device: '/dev/sdb1',
        label: 'GOTEK',
        filesystem: 'vfat',
        kind: 'removable',
        removable: true,
      },
      {
        path: '/media/NEW',
        device: '/dev/sdc1',
        label: 'NEW',
        filesystem: 'vfat',
        kind: 'removable',
        removable: true,
      },
    ],
  })

  // The already-registered destination keeps its own settings, not the defaults.
  assert.equal(after.profiles.length, 2)
  assert.equal(after.profiles[0].id, bbcProfile.id)
  assert.equal(after.profiles[0].folderLayout, 'platform')
  assert.equal(after.profiles[1].id, 'profile:/media/NEW')
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
  assert.ok(markup.includes('Prepare GoTek media'))
  // The workspace is read asynchronously now. Rendering "no profiles yet"
  // before it arrives would tell the user their library had vanished.
  assert.ok(markup.includes('Opening your library'))
  assert.ok(!markup.includes('No profiles yet'))
})

check('every screen is reachable from the navigation', () => {
  storage.clear()
  const markup = renderToString(createElement(App))

  for (const page of ['Flow', 'Profiles', 'Devices', 'Help']) {
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
    profiles: [{ ...bbcProfile, verifyChecksums: true, folderTemplate: '{platform}/{initial}' }],
    activeProfileId: bbcProfile.id,
    collections: { [bbcProfile.id]: [item] },
    removalPolicies: { [bbcProfile.id]: 'remove' },
    sources: [{ id: 'source:/library', name: 'library', path: '/library' }],
    items: [item],
  }

  const after = forTesting.fromNative(forTesting.toNative(before))

  assert.deepEqual(after.profiles, before.profiles)
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
