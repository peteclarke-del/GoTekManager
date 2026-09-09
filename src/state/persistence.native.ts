/**
 * Where the workspace actually lives.
 *
 * The library moved out of `localStorage` because it outgrew it: browsers cap
 * that storage at a few megabytes, a write past the cap fails silently, and a
 * few thousand indexed titles is already most of the budget. It is now a SQLite
 * database written in one transaction per save.
 *
 * The small preferences — theme, providers, table layout — deliberately stay in
 * `localStorage`. They are tiny, they never approach the quota, and they have
 * to be readable synchronously at first paint; loading the theme asynchronously
 * would flash the wrong palette on every start.
 */

import type { MediaItem, Profile, RemovalPolicy } from '../domain/types'
import { isDesktop } from '../native/commands'
import {
  loadNativeWorkspace,
  saveNativeWorkspace,
  upsertItems,
  type StoredItem,
  type StoredWorkspace,
} from '../native/store'
import {
  legacyLibraryItems,
  LIBRARY_KEY,
  loadWorkspace,
  splitWorkspace,
  WORKSPACE_KEY,
} from './migrations'
import { writeStored } from './persistence'
import { groupDownloads } from '../domain/downloads'
import { emptyWorkspace, type Workspace } from './workspace'

function toProfile(stored: StoredWorkspace['profiles'][number]): Profile {
  return {
    id: stored.id,
    name: stored.name,
    destination: stored.destination ?? { kind: 'folder', path: '' },
    platformId: stored.platformId,
    firmwareId: stored.firmwareId,
    organise: stored.organise,
    folderLayout: stored.folderLayout as Profile['folderLayout'],
    folderTemplate: stored.folderTemplate,
    categoryFolders: stored.categoryFolders,
    naming: stored.naming as Profile['naming'],
    verifyChecksums: stored.verifyChecksums,
    display: stored.display as Profile['display'],
  }
}

function fromNative(stored: StoredWorkspace): Workspace {
  // A library built up before downloads were grouped carries one source per
  // cached title. They are gathered here rather than left for the user to
  // remove by hand; the library's own rows follow when it is next indexed.
  const grouped = groupDownloads(stored.sources ?? [], [])

  const removalPolicies: Record<string, RemovalPolicy> = {}
  for (const [profileId, policy] of Object.entries(stored.removalPolicies ?? {})) {
    if (policy === 'remove') removalPolicies[profileId] = 'remove'
  }

  return {
    version: 2,
    profiles: (stored.profiles ?? []).map(toProfile),
    activeProfileId: stored.activeProfileId ?? '',
    // Staging is fetched for whichever profile becomes active, not up front.
    collections: {},
    removalPolicies,
    sources: grouped.sources,
  }
}

/** Turns stored rows into library items, restoring what the store folds away. */
export function itemsFromStored(stored: readonly StoredItem[]): MediaItem[] {
  return stored.map((item) => ({
    ...item,
    id: item.id ?? item.path,
    canonicalTitle: item.canonicalTitle ?? item.name,
    directory: false,
    likelyPlatformIds: item.likelyPlatformIds ?? [],
  }))
}

/** Turns a library item back into the row the store keeps. */
export function itemToStored(item: MediaItem): StoredItem {
  return {
    // Left out when they say nothing the path and the name do not.
    id: item.id === item.path ? undefined : item.id,
    source: item.source,
    path: item.path,
    name: item.name,
    extension: item.extension,
    size: item.size,
    modified: item.modified,
    canonicalTitle: item.canonicalTitle === item.name ? undefined : item.canonicalTitle,
    displayTitle: item.displayTitle,
    assignedPlatformId: item.assignedPlatformId,
    category: item.category,
    likelyPlatformIds: item.likelyPlatformIds,
    provenance: item.provenance,
  }
}

function toNative(workspace: Workspace): StoredWorkspace {
  return {
    profiles: workspace.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      destination: profile.destination,
      platformId: profile.platformId,
      firmwareId: profile.firmwareId,
      organise: profile.organise,
      folderLayout: profile.folderLayout,
      folderTemplate: profile.folderTemplate,
      categoryFolders: profile.categoryFolders,
      naming: profile.naming,
      verifyChecksums: profile.verifyChecksums ?? false,
      display: profile.display,
    })),
    activeProfileId: workspace.activeProfileId,
    removalPolicies: workspace.removalPolicies,
    sources: workspace.sources,
  }
}

function isEmpty(workspace: Workspace): boolean {
  return !workspace.profiles.length && !workspace.sources.length
}

/**
 * Loads the workspace, bringing a `localStorage` workspace across the first
 * time the native store is used.
 */
export async function loadPersistedWorkspace(): Promise<Workspace> {
  // The browser preview has no native store; it keeps working against local
  // storage so the interface can still be developed outside the app.
  if (!isDesktop()) return loadWorkspace()

  try {
    const native = fromNative(await loadNativeWorkspace())
    if (!isEmpty(native)) return native

    // Nothing in the database yet: adopt whatever the previous versions left
    // behind, including the pre-2.0 layout, and write it across. The library
    // goes with it — it no longer travels inside the workspace, so it has to be
    // written on its own or an older install would open to an empty table.
    const previous = loadWorkspace()
    const legacy = legacyLibraryItems()
    if (!isEmpty(previous) || legacy.length) {
      await saveNativeWorkspace(toNative(previous))
      if (legacy.length) await upsertItems(legacy.map(itemToStored))
      return previous
    }
    return emptyWorkspace
  } catch {
    // A database that cannot be opened must not stop the application starting.
    // Local storage still holds the previous workspace in that case.
    return loadWorkspace()
  }
}

export async function persistWorkspace(workspace: Workspace): Promise<void> {
  if (!isDesktop()) {
    const split = splitWorkspace(workspace)
    writeStored(WORKSPACE_KEY, split.workspace)
    writeStored(LIBRARY_KEY, split.library)
    return
  }
  await saveNativeWorkspace(toNative(workspace))
}

export const forTesting = { fromNative, toNative, isEmpty }
