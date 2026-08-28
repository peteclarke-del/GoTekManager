/**
 * The typed boundary between the interface and the native backend.
 *
 * Every native call goes through {@link invokeNative}, so the "desktop only"
 * guard, the argument names, and the error shape are defined once. Nothing else
 * in the application imports from `@tauri-apps/api` directly.
 */

import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { supportedExtensionList } from '../domain/catalog'
import type {
  CachedDownload,
  CacheSummary,
  ConversionSupport,
  DestinationEdit,
  FileEntry,
  ImageOptions,
  ImageSummary,
  MountedTarget,
  OnlineProvider,
  OnlineTitle,
  PhysicalDevice,
  ProviderCatalog,
  ProvisionPlan,
  ProvisionReport,
  TargetFileStatus,
  TargetSummary,
  TransferOperation,
  TransferPlan,
} from '../domain/types'

/** True when running inside the packaged desktop application. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const BROWSER_MESSAGE =
  'This needs the desktop application. The browser preview cannot read drives, ' +
  'folders, or images.'

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error(BROWSER_MESSAGE)
  return invoke<T>(command, args)
}

/** Normalises anything thrown by a command into a readable sentence. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

export async function chooseFolder(title: string): Promise<string | null> {
  if (!isDesktop()) throw new Error(BROWSER_MESSAGE)
  const selected = await open({ directory: true, multiple: false, title })
  return typeof selected === 'string' ? selected : null
}

export async function chooseImageFile(): Promise<string | null> {
  if (!isDesktop()) throw new Error(BROWSER_MESSAGE)
  const selected = await open({
    multiple: false,
    title: 'Open a FAT filesystem image',
    filters: [{ name: 'FAT filesystem image', extensions: ['img', 'ima'] }],
  })
  return typeof selected === 'string' ? selected : null
}

// ---------------------------------------------------------------------------
// Discovery and browsing (read-only)
// ---------------------------------------------------------------------------

export function discoverMounts(includeSystem = false): Promise<MountedTarget[]> {
  return invokeNative<MountedTarget[]>('mounted_targets', { includeSystem })
}

export function inspectTarget(path: string): Promise<TargetSummary> {
  return invokeNative<TargetSummary>('inspect_target', { path })
}

export function listDirectory(path: string): Promise<FileEntry[]> {
  return invokeNative<FileEntry[]>('list_directory', { path })
}

export function listImageDirectory(image: string, innerPath: string): Promise<FileEntry[]> {
  return invokeNative<FileEntry[]>('list_image_directory', { image, innerPath })
}

/**
 * Indexes a folder.
 *
 * `convert` also turns images the drive cannot read into ones it can, writing
 * the copy into the cache; the original file is left alone either way.
 */
export function scanFolder(
  path: string,
  extensions: string[] = supportedExtensionList,
  convert = true,
): Promise<FileEntry[]> {
  return invokeNative<FileEntry[]>('scan_folder', { path, extensions, convert })
}

export function supportedConversions(): Promise<ConversionSupport[]> {
  return invokeNative<ConversionSupport[]>('supported_conversions', {})
}

// ---------------------------------------------------------------------------
// Planning and writing
// ---------------------------------------------------------------------------

export function compareTargetFiles(
  target: string,
  operations: TransferOperation[],
): Promise<TargetFileStatus[]> {
  return invokeNative<TargetFileStatus[]>('compare_target_files', { target, operations })
}

export type TransferRequest = {
  target: string
  operations: TransferOperation[]
  edits: DestinationEdit[]
  removeExisting: boolean
  managedExtensions: string[]
  /** Compare a digest of every copied file against its source. */
  verifyChecksums?: boolean
}

export function planTransfer(request: TransferRequest): Promise<TransferPlan> {
  return invokeNative<TransferPlan>('plan_transfer', { ...request })
}

export function executeTransfer(request: TransferRequest): Promise<TransferPlan> {
  return invokeNative<TransferPlan>('execute_transfer', { ...request })
}

// ---------------------------------------------------------------------------
// Online catalogues
// ---------------------------------------------------------------------------

export function refreshProvider(
  provider: OnlineProvider,
  platformName: string,
  platformId: string,
  extensions: string[],
): Promise<ProviderCatalog> {
  return invokeNative<ProviderCatalog>('refresh_provider', {
    provider,
    platformName,
    platformId,
    extensions,
  })
}

export function loadProviderCatalog(
  providerId: string,
  platformId: string,
): Promise<ProviderCatalog | null> {
  return invokeNative<ProviderCatalog | null>('load_provider_catalog', {
    providerId,
    platformId,
  })
}

export function browseOnlineTitle(
  provider: OnlineProvider,
  title: OnlineTitle,
  extensions: string[] = supportedExtensionList,
): Promise<OnlineTitle[]> {
  return invokeNative<OnlineTitle[]>('browse_online_title', { provider, title, extensions })
}

export function downloadOnlineTitle(
  provider: OnlineProvider,
  title: OnlineTitle,
  extensions: string[] = supportedExtensionList,
): Promise<CachedDownload> {
  return invokeNative<CachedDownload>('download_online_title', { provider, title, extensions })
}

// ---------------------------------------------------------------------------
// Physical devices
// ---------------------------------------------------------------------------

/** Read-only. Lists every disk the operating system reports, system ones too. */
export function physicalDevices(): Promise<PhysicalDevice[]> {
  return invokeNative<PhysicalDevice[]>('physical_devices')
}

/**
 * A device's identity, used to prove nothing was swapped between planning a
 * write and performing it. Must match the backend's definition exactly.
 */
export function deviceIdentity(device: PhysicalDevice): string {
  return [device.node, device.model || '?', device.serial || '?', device.sizeBytes].join('|')
}

export type ProvisionSource =
  | { kind: 'image'; path: string }
  | { kind: 'build'; options: ImageOptions; operations: TransferOperation[] }

export type ProvisionRequest = {
  deviceIdentity: string
  source: ProvisionSource
}

/** Read-only: builds the plan, including what would be destroyed. */
export function planProvision(request: ProvisionRequest): Promise<ProvisionPlan> {
  return invokeNative<ProvisionPlan>('plan_provision', { request })
}

/**
 * Writes the media. Destructive and irreversible.
 *
 * `confirmation` must be the exact phrase from the plan; the backend re-checks
 * the device, the plan, and the phrase before anything is written.
 */
export function executeProvision(
  request: ProvisionRequest,
  confirmation: string,
): Promise<ProvisionReport> {
  return invokeNative<ProvisionReport>('execute_provision', { request, confirmation })
}

// ---------------------------------------------------------------------------
// Filesystem images
// ---------------------------------------------------------------------------

export function imageSummary(path: string): Promise<ImageSummary> {
  return invokeNative<ImageSummary>('image_summary', { path })
}

/** Creates a new image, optionally filling it. Refuses to replace an existing file. */
export function createImage(
  path: string,
  options: ImageOptions,
  operations: TransferOperation[] = [],
): Promise<number> {
  return invokeNative<number>('create_image', { path, options, operations })
}

/** Unpacks an image into a folder, never overwriting. */
export function extractImage(image: string, destination: string): Promise<string[]> {
  return invokeNative<string[]>('extract_image', { image, destination })
}

export async function chooseSaveImagePath(): Promise<string | null> {
  if (!isDesktop()) throw new Error(BROWSER_MESSAGE)
  const selected = await save({
    title: 'Create a GoTek image',
    defaultPath: 'gotek.img',
    filters: [{ name: 'FAT filesystem image', extensions: ['img'] }],
  })
  return typeof selected === 'string' ? selected : null
}

// ---------------------------------------------------------------------------
// Download cache
// ---------------------------------------------------------------------------

/** A configuration file the user may edit by hand. */
export type ConfigFile = {
  /** Returned whether or not the file exists, so the path can be shown. */
  path: string
  contents?: string
}

export function readConfigFile(name: string): Promise<ConfigFile> {
  return invokeNative<ConfigFile>('read_config_file', { name })
}

export function cacheSummary(): Promise<CacheSummary> {
  return invokeNative<CacheSummary>('cache_summary')
}

export function evictCache(maxBytes: number): Promise<string[]> {
  return invokeNative<string[]>('evict_cache', { maxBytes })
}

export function clearDownloadCache(): Promise<string[]> {
  return invokeNative<string[]>('clear_download_cache')
}
