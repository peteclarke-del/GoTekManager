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
  naming: string
  verifyChecksums: boolean
}

/** Mirrors the Rust `StoredItem`. `directory` is never persisted. */
export type StoredItem = {
  id: string
  source: string
  path: string
  name: string
  extension: string
  size: number
  modified?: number
  canonicalTitle: string
  displayTitle?: string
  assignedPlatformId?: string
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
