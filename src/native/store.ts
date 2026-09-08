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

export type StoredWorkspace = {
  profiles: StoredProfile[]
  activeProfileId: string
  /** Item ids, not copies: one library row can be staged by several profiles. */
  collections: Record<string, string[]>
  removalPolicies: Record<string, string>
  sources: SourceLocation[]
  items: StoredItem[]
}

export function loadNativeWorkspace(): Promise<StoredWorkspace> {
  return invoke<StoredWorkspace>('load_workspace')
}

/** Replaces the stored workspace in a single transaction. */
export function saveNativeWorkspace(workspace: StoredWorkspace): Promise<void> {
  return invoke<void>('save_workspace', { workspace })
}
