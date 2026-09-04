/**
 * The workspace: every profile, the library that feeds them, and each
 * profile's staged collection.
 *
 * This is a reducer rather than a dozen `useState` setters because most
 * changes touch more than one slice. Assigning a platform, for instance, has to
 * update the library *and* every collection that already holds the item; doing
 * that in one place is the difference between a rule and a habit.
 */

import { inferPlatformId } from '../domain/catalog'
import { basename } from '../domain/paths'
import { mapValues, omitKey, removeById, replaceById, upsertById } from '../domain/records'
import type {
  Destination,
  MediaItem,
  MountedTarget,
  Profile,
  ProfileDefaults,
  RemovalPolicy,
  SourceLocation,
  TargetSummary,
} from '../domain/types'

export type Workspace = {
  version: 2
  profiles: Profile[]
  activeProfileId: string
  /** Staged titles per profile id. */
  collections: Record<string, MediaItem[]>
  removalPolicies: Record<string, RemovalPolicy>
  sources: SourceLocation[]
  items: MediaItem[]
}

export const emptyWorkspace: Workspace = {
  version: 2,
  profiles: [],
  activeProfileId: '',
  collections: {},
  removalPolicies: {},
  sources: [],
  items: [],
}

/**
 * A profile's id is its destination path.
 *
 * The path alone is the identity: a folder the user picked and the same folder
 * discovered as a mounted volume are one destination, and registering it twice
 * would give one GoTek two collections that could disagree.
 */
export function profileIdFor(destination: Destination): string {
  return `profile:${destination.path}`
}

export function createProfile(
  destination: Destination,
  defaults: ProfileDefaults,
  name = basename(destination.path),
): Profile {
  return {
    id: profileIdFor(destination),
    name,
    destination,
    platformId: inferPlatformId(name),
    // Evidence found on the media beats the default, but the user can override.
    firmwareId: destination.detectedFirmwareId || defaults.firmwareId,
    organise: defaults.organise,
    folderLayout: defaults.folderLayout,
    naming: defaults.naming,
  }
}

/**
 * The profiles a set of chosen mounts would add.
 *
 * A mount already registered is left out entirely rather than rebuilt: it keeps
 * the settings and the staged collection it already has. The rest come back as
 * drafts for the user to name, because a volume label cannot say which machine
 * the stick is for.
 */
export function profilesForMounts(
  mounts: MountedTarget[],
  defaults: ProfileDefaults,
  existing: Profile[],
): Profile[] {
  return mounts
    .map((mount) => createProfile(destinationFromMount(mount), defaults, mount.label))
    .filter((profile) => !existing.some((entry) => entry.id === profile.id))
}

export function destinationFromMount(mount: MountedTarget): Destination {
  return {
    kind: 'volume',
    path: mount.path,
    device: mount.device,
    filesystem: mount.filesystem,
    totalBytes: mount.totalBytes,
    availableBytes: mount.availableBytes,
    removable: mount.removable,
    detectedFirmwareId: mount.detectedFirmwareId,
  }
}

/** Image destinations are browsed read-only; nothing may be written to them. */
export function isWritable(profile: Profile | undefined): boolean {
  return profile ? profile.destination.kind !== 'image' : false
}

export function activeProfileOf(workspace: Workspace): Profile | undefined {
  return (
    workspace.profiles.find((profile) => profile.id === workspace.activeProfileId) ||
    workspace.profiles[0]
  )
}

/**
 * A shared empty collection.
 *
 * Returning a fresh `[]` would give every render a new array identity, which
 * would invalidate the memoised transfer operations and re-plan forever.
 */
const NO_ITEMS: MediaItem[] = []

export function collectionOf(workspace: Workspace, profileId: string | undefined): MediaItem[] {
  return (profileId && workspace.collections[profileId]) || NO_ITEMS
}

export function removalPolicyOf(
  workspace: Workspace,
  profileId: string | undefined,
): RemovalPolicy {
  return (profileId && workspace.removalPolicies[profileId]) || 'keep'
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type WorkspaceAction =
  | { type: 'profileAdded'; profile: Profile }
  | { type: 'profileUpdated'; profile: Profile }
  | { type: 'profileRemoved'; id: string }
  | { type: 'profileSelected'; id: string }
  | { type: 'profileDestinationChecked'; id: string; summary: TargetSummary }
  | { type: 'sourceIndexed'; source: SourceLocation; items: MediaItem[] }
  /** Titles arriving one at a time, such as downloads, which add rather than replace. */
  | { type: 'itemsImported'; source: SourceLocation; items: MediaItem[] }
  | { type: 'sourceRenamed'; source: SourceLocation }
  | { type: 'sourceRemoved'; source: SourceLocation }
  | { type: 'platformAssigned'; itemIds: string[]; platformId: string }
  | { type: 'categoryAssigned'; itemIds: string[]; categoryId: string }
  | { type: 'displayTitleSet'; itemId: string; displayTitle: string }
  | { type: 'collectionAdded'; profileId: string; items: MediaItem[] }
  | { type: 'collectionRemoved'; profileId: string; itemIds: string[] }
  | { type: 'collectionCleared'; profileId: string }
  | { type: 'removalPolicySet'; profileId: string; policy: RemovalPolicy }
  | { type: 'libraryCleared' }
  /** Replaces everything, once, when the stored workspace has been read. */
  | { type: 'workspaceLoaded'; workspace: Workspace }

/** Applies a change to every profile's staged collection at once. */
function acrossCollections(
  collections: Workspace['collections'],
  transform: (items: MediaItem[]) => MediaItem[],
): Workspace['collections'] {
  return mapValues(collections, transform)
}

/**
 * Edits chosen titles wherever they appear.
 *
 * A title staged by three profiles is one row in the library and a reference in
 * each collection, so every edit has to reach all four. Doing it in one place is
 * the difference between a rule and a habit, and a whole selection is walked
 * once rather than once per title.
 */
function editItems(
  state: Workspace,
  itemIds: string[],
  edit: (item: MediaItem) => MediaItem,
): Workspace {
  const chosen = new Set(itemIds)
  const apply = (item: MediaItem): MediaItem => (chosen.has(item.id) ? edit(item) : item)
  return {
    ...state,
    items: state.items.map(apply),
    collections: acrossCollections(state.collections, (items) => items.map(apply)),
  }
}

export function workspaceReducer(state: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case 'profileAdded':
      return {
        ...state,
        profiles: upsertById(state.profiles, action.profile),
        activeProfileId: action.profile.id,
      }

    case 'profileUpdated':
      return { ...state, profiles: replaceById(state.profiles, action.profile) }

    case 'profileRemoved': {
      const profiles = removeById(state.profiles, action.id)
      return {
        ...state,
        profiles,
        // Removing a profile must not leave the flow pointing at nothing.
        activeProfileId:
          state.activeProfileId === action.id ? profiles[0]?.id || '' : state.activeProfileId,
        collections: omitKey(state.collections, action.id),
        removalPolicies: omitKey(state.removalPolicies, action.id),
      }
    }

    case 'profileSelected':
      return { ...state, activeProfileId: action.id }

    case 'profileDestinationChecked': {
      const profile = state.profiles.find((candidate) => candidate.id === action.id)
      if (!profile) return state
      const updated: Profile = {
        ...profile,
        destination: {
          ...profile.destination,
          totalBytes: action.summary.totalBytes,
          availableBytes: action.summary.availableBytes,
          detectedFirmwareId:
            action.summary.detectedFirmwareId || profile.destination.detectedFirmwareId,
        },
      }
      return { ...state, profiles: replaceById(state.profiles, updated) }
    }

    case 'sourceIndexed': {
      // Re-indexing replaces this source's titles rather than accumulating
      // stale entries for files that have since been deleted.
      const others = state.items.filter((item) => item.source !== action.source.path)
      const indexed = new Map(action.items.map((item) => [item.id, item]))
      return {
        ...state,
        sources: upsertById(state.sources, action.source),
        items: [...others, ...action.items],
        collections: acrossCollections(state.collections, (items) =>
          items.flatMap((item) => {
            if (item.source !== action.source.path) return [item]
            const refreshed = indexed.get(item.id)
            return refreshed ? [refreshed] : []
          }),
        ),
      }
    }

    case 'itemsImported':
      // Unlike indexing, this does not stand for everything the source holds:
      // a download arrives on its own, and the ones cached before it are still
      // there. Replacing would empty the site's source on every new title.
      return {
        ...state,
        sources: upsertById(state.sources, action.source),
        items: upsertById(state.items, ...action.items),
      }

    case 'sourceRenamed':
      return { ...state, sources: replaceById(state.sources, action.source) }

    case 'sourceRemoved':
      return {
        ...state,
        sources: removeById(state.sources, action.source.id),
        items: state.items.filter((item) => item.source !== action.source.path),
        collections: acrossCollections(state.collections, (items) =>
          items.filter((item) => item.source !== action.source.path),
        ),
      }

    case 'platformAssigned':
      return editItems(state, action.itemIds, (item) => ({
        ...item,
        assignedPlatformId: action.platformId || undefined,
      }))

    case 'categoryAssigned':
      // An empty category clears it, which is a real answer: a title nobody has
      // sorted yet is not the same as one filed under Games.
      return editItems(state, action.itemIds, (item) => ({
        ...item,
        category: action.categoryId || undefined,
      }))

    case 'displayTitleSet': {
      // An empty alias clears it, restoring the generated name. The library's
      // canonical title is never touched either way.
      const alias = action.displayTitle.trim()
      return editItems(state, [action.itemId], (item) => ({
        ...item,
        displayTitle: alias || undefined,
      }))
    }

    case 'collectionAdded':
      return {
        ...state,
        collections: {
          ...state.collections,
          [action.profileId]: upsertById(
            state.collections[action.profileId] || [],
            ...action.items,
          ),
        },
      }

    case 'collectionRemoved':
      return {
        ...state,
        collections: {
          ...state.collections,
          [action.profileId]: removeById(
            state.collections[action.profileId] || [],
            ...action.itemIds,
          ),
        },
      }

    case 'collectionCleared':
      return {
        ...state,
        collections: { ...state.collections, [action.profileId]: [] },
        removalPolicies: { ...state.removalPolicies, [action.profileId]: 'keep' },
      }

    case 'removalPolicySet':
      return {
        ...state,
        removalPolicies: { ...state.removalPolicies, [action.profileId]: action.policy },
      }

    case 'workspaceLoaded':
      return action.workspace

    case 'libraryCleared':
      return {
        ...state,
        sources: [],
        items: [],
        collections: mapValues(state.collections, () => []),
      }

    default:
      return state
  }
}
