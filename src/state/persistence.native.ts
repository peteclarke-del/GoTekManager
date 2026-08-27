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

import type { Destination, MediaItem, Profile, RemovalPolicy } from '../domain/types'
import { isDesktop } from '../native/commands'
import {
  loadNativeWorkspace,
  saveNativeWorkspace,
  type StoredWorkspace,
} from '../native/store'
import { LIBRARY_KEY, loadWorkspace, splitWorkspace, WORKSPACE_KEY } from './migrations'
import { writeStored } from './persistence'
import { emptyWorkspace, type Workspace } from './workspace'

function toProfile(stored: StoredWorkspace['profiles'][number]): Profile {
  return {
    id: stored.id,
    name: stored.name,
    destination: (stored.destination ?? { kind: 'folder', path: '' }) as Destination,
    platformId: stored.platformId,
    firmwareId: stored.firmwareId,
    organise: stored.organise,
    folderLayout: stored.folderLayout as Profile['folderLayout'],
    folderTemplate: stored.folderTemplate,
    naming: stored.naming as Profile['naming'],
    verifyChecksums: stored.verifyChecksums,
  }
}

function fromNative(stored: StoredWorkspace): Workspace {
  const items: MediaItem[] = stored.items.map((item) => ({
    ...item,
    directory: false,
    likelyPlatformIds: item.likelyPlatformIds ?? [],
  }))
  const byId = new Map(items.map((item) => [item.id, item]))

  const collections: Record<string, MediaItem[]> = {}
  for (const [profileId, itemIds] of Object.entries(stored.collections ?? {})) {
    // A staged id whose title has since left the library is dropped rather
    // than resurrected as a placeholder that no longer points at a file.
    const staged = itemIds.map((id) => byId.get(id)).filter((item): item is MediaItem => !!item)
    if (staged.length) collections[profileId] = staged
  }

  const removalPolicies: Record<string, RemovalPolicy> = {}
  for (const [profileId, policy] of Object.entries(stored.removalPolicies ?? {})) {
    if (policy === 'remove') removalPolicies[profileId] = 'remove'
  }

  return {
    version: 2,
    profiles: (stored.profiles ?? []).map(toProfile),
    activeProfileId: stored.activeProfileId ?? '',
    collections,
    removalPolicies,
    sources: stored.sources ?? [],
    items,
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
      naming: profile.naming,
      verifyChecksums: profile.verifyChecksums ?? false,
    })),
    activeProfileId: workspace.activeProfileId,
    // Collections are stored as references, so a title staged for three
    // profiles is one row in the library rather than three copies of it.
    collections: Object.fromEntries(
      Object.entries(workspace.collections).map(([profileId, items]) => [
        profileId,
        items.map((item) => item.id),
      ]),
    ),
    removalPolicies: workspace.removalPolicies,
    sources: workspace.sources,
    items: workspace.items.map((item) => ({
      id: item.id,
      source: item.source,
      path: item.path,
      name: item.name,
      extension: item.extension,
      size: item.size,
      modified: item.modified,
      canonicalTitle: item.canonicalTitle,
      displayTitle: item.displayTitle,
      assignedPlatformId: item.assignedPlatformId,
      likelyPlatformIds: item.likelyPlatformIds,
      provenance: item.provenance,
    })),
  }
}

function isEmpty(workspace: Workspace): boolean {
  return (
    !workspace.profiles.length && !workspace.items.length && !workspace.sources.length
  )
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
    // behind, including the pre-2.0 layout, and write it across.
    const previous = loadWorkspace()
    if (!isEmpty(previous)) {
      await saveNativeWorkspace(toNative(previous))
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
