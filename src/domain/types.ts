/**
 * The application's domain model.
 *
 * A **profile** is the single unit the user works with: it owns one
 * destination together with the platform, firmware, layout, and naming rules
 * used to write to it. Earlier versions split this across a "target" and a
 * "setup" that had to be kept in step by hand; keeping them together removes a
 * whole class of inconsistency and matches how the interface talks about them.
 */

export type Page = 'Flow' | 'Profiles' | 'Devices' | 'Help'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type NamingRule = 'original' | 'oled'
export type FolderLayout = 'flat' | 'platform' | 'category' | 'custom'

/**
 * What the drive's own display is, in FlashFloppy's own vocabulary.
 *
 * `auto` is the firmware's default and writes nothing, leaving a drive that
 * detects its panel correctly alone. The rest name a panel outright, which is
 * what makes `-rotate` possible: the firmware only accepts it on a named OLED,
 * and it is the setting that puts an upside-down panel the right way up.
 */
export type DisplayType =
  | 'auto'
  | 'oled-128x32'
  | 'oled-128x32-rotate'
  | 'oled-128x64'
  | 'oled-128x64-rotate'

/** What happens to destination files the collection does not include. */
export type RemovalPolicy = 'keep' | 'remove'

/**
 * `folder` is a location the user picked, `volume` is a discovered mount, and
 * `image` is a FAT container browsed read-only.
 */
export type DestinationKind = 'folder' | 'volume' | 'image'

export type Destination = {
  kind: DestinationKind
  path: string
  device?: string
  filesystem?: string
  totalBytes?: number
  availableBytes?: number
  removable?: boolean
  /** Firmware inferred from configuration files found in the volume root. */
  detectedFirmwareId?: string
}

export type Profile = {
  id: string
  name: string
  destination: Destination
  platformId: string
  firmwareId: string
  organise: boolean
  folderLayout: FolderLayout
  /** The drive's panel, written to FF.CFG. Absent means the firmware default. */
  display?: DisplayType
  /** Used when folderLayout is 'custom'. See renderFolderTemplate. */
  folderTemplate?: string
  naming: NamingRule
  /**
   * Compare a digest of every copied file against its source.
   *
   * Slower, but it is the only way to catch media that accepts bytes and
   * stores something else, which is how a failing USB stick behaves.
   */
  verifyChecksums?: boolean
}

/** The rules a newly created profile starts from. */
export type ProfileDefaults = Pick<
  Profile,
  'firmwareId' | 'organise' | 'folderLayout' | 'naming'
>

export type AppSettings = {
  theme: ThemeChoice
  defaults: ProfileDefaults
  /**
   * Whether indexing converts images the drive cannot read into ones it can.
   *
   * The conversion writes a copy into the application's cache; the file it was
   * made from is never modified.
   */
  convertIncompatible: boolean
}

/** The drive's own configuration file, as it stands on the destination. */
export type FirmwareConfigState = {
  /** Where the firmware reads it from, relative to the destination root. */
  path: string
  exists: boolean
  contents?: string
}

/** A conversion the application can perform, as the native side describes it. */
export type ConversionSupport = {
  conversion: string
  from: string
  to: string
  summary: string
}

export type SourceLocation = {
  id: string
  name: string
  path: string
}

export type FileEntry = {
  name: string
  path: string
  /** Lowercase and without a leading dot, matching the native backend. */
  extension: string
  size: number
  modified?: number
  directory: boolean
}

export type Provenance = {
  providerId: string
  remoteId: string
  sourceUrl: string
  license?: string
}

export type MediaItem = FileEntry & {
  id: string
  /** The source location or download cache this file was indexed from. */
  source: string
  likelyPlatformIds: string[]
  assignedPlatformId?: string
  canonicalTitle: string
  /**
   * An explicit name for the drive's display, chosen by the user.
   *
   * Kept separate from `canonicalTitle` so the library never loses the real
   * name: this only ever affects what is written to the media, and clearing it
   * restores the generated name.
   */
  displayTitle?: string
  /**
   * What the title is — a game, an application, a demo — rather than which
   * machine it runs on. Read from the library's own folders where it says so,
   * and set by hand otherwise. See {@link ./categories}.
   */
  category?: string
  provenance?: Provenance
}

/** A release published for this application, as the update check reads it. */
export type PublishedRelease = {
  tag: string
  name: string
  notes: string
  url: string
  draft: boolean
  prerelease: boolean
}

// ---------------------------------------------------------------------------
// Native command results
// ---------------------------------------------------------------------------

export type TargetSummary = {
  path: string
  exists: boolean
  kind: 'folder' | 'image' | 'missing'
  writable: boolean
  entries: number
  totalBytes?: number
  availableBytes?: number
  detectedFirmwareId?: string
}

export type MountKind = 'removable' | 'network' | 'fixed' | 'system'

export type MountedTarget = {
  path: string
  device: string
  label: string
  filesystem: string
  kind: MountKind
  totalBytes?: number
  availableBytes?: number
  removable: boolean
  detectedFirmwareId?: string
}

export type TransferOperation = {
  source: string
  /** Always `/`-separated and relative to the destination root. */
  relativePath: string
  size: number
}

export type FileStatus =
  | 'new'
  | 'identical'
  | 'different'
  /** On the destination, but not where this profile would write it. */
  | 'elsewhere'
  | 'unavailable'

export type TargetFileStatus = {
  source: string
  relativePath: string
  status: FileStatus
  /** Where it actually is, when the status is `elsewhere`. */
  foundAt?: string
}

export type EditKind = 'move' | 'delete'

export type DestinationEdit = {
  kind: EditKind
  path: string
  destination?: string
}

export type ResultStatus = 'add' | 'unchanged' | 'move' | 'remove' | 'conflict'

export type TransferResultEntry = {
  path: string
  previousPath?: string
  status: ResultStatus
  currentSize?: number
  resultSize?: number
}

/**
 * The merged inventory the native planner returns. Every view of the
 * destination is derived from `result`, so the interface never keeps a second
 * model that could disagree with the backend.
 */
export type TransferPlan = {
  target: string
  operations: TransferOperation[]
  edits: DestinationEdit[]
  removals: string[]
  result: TransferResultEntry[]
  totalBytes: number
  availableBytes?: number
  warnings: string[]
  ready: boolean
}

// ---------------------------------------------------------------------------
// Online catalogues
// ---------------------------------------------------------------------------

export type ProviderAdapter = 'internetArchive' | 'jsonFeed' | 'htmlSite' | 'demozoo'

export type OnlineProvider = {
  id: string
  name: string
  adapter: ProviderAdapter
  catalogUrl?: string
  query?: string
  platformId?: string
  /** Shipped with the application, so it can be changed but not deleted. */
  builtIn?: boolean
  /** A shipped source the user has changed, which can be put back as it was. */
  overridden?: boolean
  /**
   * Inspect the site even though its robots.txt refuses.
   *
   * Never set on a shipped source. The user turns it on per source, having
   * been told plainly what it means and that the consequences are theirs.
   */
  ignoreRobots?: boolean
  /** Identify as something other than this application. */
  userAgent?: string
}

export type OnlineTitle = {
  providerId: string
  remoteId: string
  title: string
  platformId?: string
  extension?: string
  size?: number
  downloadUrl?: string
  detailsUrl?: string
  license?: string
  updated?: string
}

export type ProviderCatalog = {
  providerId: string
  platformId: string
  refreshedAt: number
  items: OnlineTitle[]
}

export type CachedDownload = {
  entries: FileEntry[]
  cachePath: string
  reused: boolean
  sourceUrl: string
  license?: string
}

export type Notice = {
  kind: 'success' | 'error' | 'info'
  text: string
}

// ---------------------------------------------------------------------------
// Physical devices and provisioning
// ---------------------------------------------------------------------------

export type DevicePartition = {
  node: string
  sizeBytes: number
  filesystem?: string
  label?: string
  uuid?: string
  mountPoints: string[]
}

export type PhysicalDevice = {
  /** The stable OS handle, and how the device is addressed for writing. */
  node: string
  name: string
  vendor?: string
  model?: string
  serial?: string
  sizeBytes: number
  removable: boolean
  transport?: string
  partitions: DevicePartition[]
  /** Carries the running system. Never writable, at all. */
  system: boolean
}

export type Destroyed = {
  node: string
  description: string
}

export type ProvisionPlan = {
  device: PhysicalDevice
  imageBytes: number
  steps: string[]
  destroys: Destroyed[]
  warnings: string[]
  ready: boolean
  /** The exact text the user must type to authorise the write. */
  confirmationPhrase: string
}

export type ProvisionReport = {
  device: string
  bytesWritten: number
  verified: boolean
}

export type FatKind = 'fat16' | 'fat32' | 'auto'

export type ImageOptions = {
  sizeBytes: number
  label: string
  fat: FatKind
  partitioned: boolean
}

export type ImageSummary = {
  path: string
  sizeBytes: number
  partitioned: boolean
  filesystemBytes: number
  fileCount: number
  usedBytes: number
}

export type CacheSummary = {
  totalBytes: number
  downloadCount: number
  catalogueCount: number
}
