/**
 * One-time migration from the pre-2.0 storage layout.
 *
 * The old model kept a "target" and a separate "setup profile" that had to be
 * matched up by id and kept in step by hand. This reads whatever is on disk and
 * produces the unified workspace, without deleting the old keys, so an upgrade
 * can be rolled back by reinstalling the previous version.
 */

import { basename } from '../domain/paths'
import { readStored } from './persistence'
import { emptyWorkspace, profileIdFor, type Workspace } from './workspace'
import { inferPlatformId } from '../domain/catalog'
import type {
  AppSettings,
  Destination,
  MediaItem,
  Profile,
  RemovalPolicy,
  SourceLocation,
} from '../domain/types'

export const WORKSPACE_KEY = 'gm.workspace.v2'
/**
 * The library is stored apart from the rest of the workspace.
 *
 * It is by far the largest slice — a few thousand indexed titles serialise to
 * megabytes — and it changes rarely, whereas selecting a profile or staging a
 * title changes the small slice constantly. Keeping them in one document made
 * every click rewrite the whole library.
 */
export const LIBRARY_KEY = 'gm.library.v2'
export const SETTINGS_KEY = 'gm.settings.v2'
export const PROVIDERS_KEY = 'gm.providers.v2'
export const TABLE_PREFS_KEY = 'gm.tablePrefs.v2'

export const defaultSettings: AppSettings = {
  theme: 'system',
  convertIncompatible: true,
  defaults: {
    firmwareId: 'flashfloppy',
    organise: true,
    folderLayout: 'platform',
    naming: 'oled',
  },
}

/** The shapes previous versions wrote. Only fields we still need are listed. */
type LegacySettings = Partial<{
  theme: AppSettings['theme']
  organise: boolean
  naming: Profile['naming']
  folderLayout: Profile['folderLayout']
  firmwareId: string
}>

type LegacyTarget = {
  id: string
  name: string
  kind?: 'USB' | 'Folder' | 'Image'
  path: string
  device?: string
  filesystem?: string
  firmwareId?: string
  profileId?: string
  discovered?: boolean
}

type LegacyProfile = {
  id: string
  name: string
  platformId?: string
  firmwareId?: string
  organise?: boolean
  naming?: Profile['naming']
  folderLayout?: Profile['folderLayout']
}

type LegacyItem = Partial<MediaItem> & { platformIds?: string[] }

function migrateSettings(): AppSettings {
  const legacy = readStored<LegacySettings>('gm.settings', {})
  return {
    theme: legacy.theme ?? defaultSettings.theme,
    convertIncompatible: defaultSettings.convertIncompatible,
    defaults: {
      firmwareId: legacy.firmwareId ?? defaultSettings.defaults.firmwareId,
      organise: legacy.organise ?? defaultSettings.defaults.organise,
      folderLayout: legacy.folderLayout ?? defaultSettings.defaults.folderLayout,
      naming: legacy.naming ?? defaultSettings.defaults.naming,
    },
  }
}

/** Discards entries too damaged to place, and fills in fields added since. */
function migrateItems(items: LegacyItem[]): MediaItem[] {
  return items
    .filter((item): item is LegacyItem & MediaItem =>
      Boolean(item && item.id && item.path && item.name),
    )
    .map((item) => ({
      ...item,
      likelyPlatformIds: item.likelyPlatformIds || item.platformIds || [],
      canonicalTitle: item.canonicalTitle || item.name,
    }))
}

function migrateSources(sources: Array<string | SourceLocation>): SourceLocation[] {
  return sources.map((source) =>
    typeof source === 'string'
      ? { id: `source:${source}`, name: basename(source), path: source }
      : source,
  )
}

function legacyDestination(target: LegacyTarget): Destination {
  const kind: Destination['kind'] = target.id.startsWith('image:')
    ? 'image'
    : target.discovered
      ? 'volume'
      : 'folder'
  return {
    kind,
    path: target.path,
    device: target.device,
    filesystem: target.filesystem,
    removable: target.kind === 'USB',
    detectedFirmwareId: target.firmwareId,
  }
}

/**
 * Rebuilds one profile from a legacy target and whichever settings record was
 * paired with it, keeping the old id as an alias so staged collections survive.
 */
function migrateProfile(
  target: LegacyTarget,
  profiles: LegacyProfile[],
  settings: AppSettings,
): { profile: Profile; legacyId: string } {
  const paired =
    profiles.find((profile) => profile.id === `profile-setup-${target.id}`) ||
    profiles.find((profile) => profile.id === target.profileId)
  const destination = legacyDestination(target)
  const name = target.name || basename(target.path)
  return {
    legacyId: target.id,
    profile: {
      id: profileIdFor(destination),
      name,
      destination,
      platformId: paired?.platformId || inferPlatformId(name),
      firmwareId: paired?.firmwareId || target.firmwareId || settings.defaults.firmwareId,
      organise: paired?.organise ?? settings.defaults.organise,
      folderLayout: paired?.folderLayout || settings.defaults.folderLayout,
      naming: paired?.naming || settings.defaults.naming,
    },
  }
}

function migrateWorkspace(settings: AppSettings): Workspace {
  const targets = readStored<LegacyTarget[]>('gm.targets', []).filter(
    (target) => target && target.path,
  )
  const legacyProfiles = readStored<LegacyProfile[]>('gm.profiles', [])
  const migrated = targets.map((target) => migrateProfile(target, legacyProfiles, settings))
  const idByLegacyId = new Map(migrated.map((entry) => [entry.legacyId, entry.profile.id]))

  const legacyCollections = readStored<Record<string, LegacyItem[]>>('gm.setupQueues', {})
  const legacyPolicies = readStored<Record<string, boolean>>('gm.setupMatchModes', {})
  const collections: Record<string, MediaItem[]> = {}
  const removalPolicies: Record<string, RemovalPolicy> = {}
  for (const [legacyId, newId] of idByLegacyId) {
    const items = migrateItems(legacyCollections[legacyId] || [])
    if (items.length) collections[newId] = items
    if (legacyPolicies[legacyId]) removalPolicies[newId] = 'remove'
  }

  const selected = readStored<string>('gm.selectedTarget', '')
  const profiles = migrated.map((entry) => entry.profile)
  return {
    ...emptyWorkspace,
    profiles,
    activeProfileId: idByLegacyId.get(selected) || profiles[0]?.id || '',
    collections,
    removalPolicies,
    sources: migrateSources(readStored('gm.sources', [])),
    items: migrateItems(readStored('gm.items', [])),
  }
}

export type StoredWorkspace = Omit<Workspace, 'sources' | 'items'>
export type StoredLibrary = Pick<Workspace, 'sources' | 'items'>

export function splitWorkspace(workspace: Workspace): {
  workspace: StoredWorkspace
  library: StoredLibrary
} {
  const { sources, items, ...rest } = workspace
  return { workspace: rest, library: { sources, items } }
}

/** Loads the workspace, migrating the previous layout the first time. */
export function loadWorkspace(): Workspace {
  const stored = readStored<Partial<Workspace> | null>(WORKSPACE_KEY, null)
  if (stored && stored.version === 2) {
    const library = readStored<Partial<StoredLibrary>>(LIBRARY_KEY, {})
    // Defend against a truncated or hand-edited store.
    return {
      ...emptyWorkspace,
      ...stored,
      sources: library.sources ?? stored.sources ?? [],
      items: library.items ?? stored.items ?? [],
    }
  }
  return migrateWorkspace(loadSettings())
}

/**
 * Fills in whatever a stored settings record predates.
 *
 * Every release that adds a setting makes every record already on disk older
 * than the shape being read. Spreading the defaults underneath is what stops a
 * setting added since from arriving as `undefined` — which a checkbox shows as
 * off, whatever the default was meant to be. The nested defaults are merged in
 * their own right for the same reason.
 */
export function reviveSettings(stored: AppSettings): AppSettings {
  return {
    ...defaultSettings,
    ...stored,
    defaults: { ...defaultSettings.defaults, ...stored.defaults },
  }
}

export function loadSettings(): AppSettings {
  const stored = readStored<AppSettings | null>(SETTINGS_KEY, null)
  if (stored?.defaults) return reviveSettings(stored)
  return migrateSettings()
}
