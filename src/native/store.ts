/** Typed access to the native persistent store. */

import { invoke } from '@tauri-apps/api/core'
import type { Destination, Provenance, SourceLocation } from '../domain/types'

/** Mirrors the Rust `StoredProfile`. */
export type StoredProfile = {
  id: string
  name: string
  destination: Destination
  platformId: string
  firmwareId: string
  organise: boolean
  folderLayout: string
  folderTemplate?: string
  /** The destination's own folder names, by category id. */
  categoryFolders?: Record<string, string>
  naming: string
  verifyChecksums: boolean
  display?: string
}

/**
 * Mirrors the Rust `StoredItem`. `directory` is never persisted.
 *
 * `id` and `canonicalTitle` are absent whenever they are the same as `path` and
 * `name`, which for a scanned title is always: they are the longest strings in
 * the library, and sending each of them twice costs megabytes on the way to the
 * window without saying anything. Only a downloaded title, named by the
 * catalogue rather than by its file, carries them.
 */
export type StoredItem = {
  id?: string
  source: string
  path: string
  name: string
  extension: string
  size: number
  modified?: number
  canonicalTitle?: string
  displayTitle?: string
  assignedPlatformId?: string
  category?: string
  likelyPlatformIds: string[]
  provenance?: Provenance
}

/**
 * The workspace's own shape: everything except the library itself.
 *
 * Profiles and sources are tens of rows however large a collection grows, so
 * they still travel whole. The library does not, and neither does what a
 * profile has staged — those are asked for by the screen that needs them, a
 * page at a time, and changed by the commands below. Carrying them here would
 * put the size of the collection back in the path of every start.
 */
export type StoredWorkspace = {
  profiles: StoredProfile[]
  activeProfileId: string
  removalPolicies: Record<string, string>
  sources: SourceLocation[]
}

/** What the library page is showing: a filter, an order, and one page of it. */
export type ItemQuery = {
  /** Titles this machine might run. Empty asks for the whole library. */
  platformId?: string
  /** Restrict to these source folders. Empty means all of them. */
  sources?: string[]
  search?: string
  sort?: string
  descending?: boolean
  offset?: number
  /** How many rows to return. Zero asks only for the counts. */
  limit?: number
}

export type ItemPage = {
  rows: StoredItem[]
  /** How many titles match, of which `rows` is one page. */
  total: number
  /** How many each source contributes, for the sidebar. */
  bySource: Record<string, number>
}

/** Fields a person can change. `null` clears one; absent leaves it alone. */
export type ItemChanges = {
  assignedPlatformId?: string | null
  category?: string | null
  displayTitle?: string | null
}

export function loadNativeWorkspace(): Promise<StoredWorkspace> {
  return invoke<StoredWorkspace>('load_workspace')
}

/** Replaces the stored workspace in a single transaction. */
export function saveNativeWorkspace(workspace: StoredWorkspace): Promise<void> {
  return invoke<void>('save_workspace', { workspace })
}

// ---------------------------------------------------------------------------
// The library, asked rather than carried
// ---------------------------------------------------------------------------

/** One page of the library, with the counts that describe the whole of it. */
export function queryItems(query: ItemQuery): Promise<ItemPage> {
  return invoke<ItemPage>('query_items', { query })
}

/** Replaces everything indexed from one source with what was just found. */
export function replaceSourceItems(source: string, items: StoredItem[]): Promise<void> {
  return invoke<void>('replace_source_items', { source, items })
}

/** Adds or updates titles without disturbing anything else. */
export function upsertItems(items: StoredItem[]): Promise<void> {
  return invoke<void>('upsert_items', { items })
}

/** Forgets a source and everything indexed from it. */
export function forgetSource(source: string): Promise<void> {
  return invoke<void>('forget_source', { source })
}

/** Applies one decision to a set of titles. */
/**
 * The titles the library has no category for, a page at a time.
 *
 * Read back so the rules can be asked about them again; see
 * {@link useRecategorise}. Only these rows are read, never the library.
 */
export function uncategorisedItems(limit: number, offset: number): Promise<StoredItem[]> {
  return invoke<StoredItem[]>('uncategorised_items', { limit, offset })
}

export function updateItems(ids: string[], changes: ItemChanges): Promise<void> {
  return invoke<void>('update_items', { ids, changes })
}

/** Empties the library, leaving profiles and their settings alone. */
export function clearLibrary(): Promise<void> {
  return invoke<void>('clear_library')
}

// ---------------------------------------------------------------------------
// What a profile has staged
// ---------------------------------------------------------------------------

/** The names of everything held for one machine, for the catalogue to match. */
export function heldTitles(platformId: string): Promise<string[]> {
  return invoke<string[]>('held_titles', { platformId })
}

/** The titles one profile has staged, in the order they were staged. */
export function stagedItems(profileId: string): Promise<StoredItem[]> {
  return invoke<StoredItem[]>('staged_items', { profileId })
}

export function stageItems(profileId: string, ids: string[]): Promise<void> {
  return invoke<void>('stage_items', { profileId, ids })
}

export function unstageItems(profileId: string, ids: string[]): Promise<void> {
  return invoke<void>('unstage_items', { profileId, ids })
}

export function clearCollection(profileId: string): Promise<void> {
  return invoke<void>('clear_collection', { profileId })
}
