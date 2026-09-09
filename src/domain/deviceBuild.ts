/**
 * Copying a profile's destination onto a stick.
 *
 * The guided flow curates a folder; this takes that folder — wherever it is
 * kept, a folder, a mounted volume or a FAT image — and writes a copy of it to
 * real media. The folder is the master and the stick is a copy of it, so
 * nothing here reorganises: the layout that was curated is the layout written.
 *
 * The whole module exists because a collection rarely fits. What it offers is
 * an honest account of what will not fit and a way to choose what to leave out,
 * for one write only, without touching the master.
 */

import { acceptedFormats } from './catalog'
import { categoryIn, wordsOf } from './categories'
import { formatBytes } from './media'
import { dottedExtensionOf } from './paths'
import { readTags } from './tags'
import type { Profile } from './types'

/** One file held by a profile's destination. */
export type HeldFile = {
  /** How to read it: a path, or a container and the entry inside it. */
  source: string
  /** `/`-separated and relative to the destination root. */
  relativePath: string
  size: number
}

/** What a stick of a given size actually holds. */
export type Capacity = {
  usableBytes: number
  clusterBytes: number
}

/**
 * What these files cost on a volume, rather than what they add up to.
 *
 * Every file occupies a whole number of clusters, so an 881 KB disk image on a
 * 32 KB cluster costs 896 KB. Across ten thousand titles that difference runs
 * to hundreds of megabytes, which is the difference between a write that fits
 * and one that fails three quarters of the way through. Counting bytes would be
 * simpler and would lie.
 */
export function costOf(files: readonly HeldFile[], clusterBytes: number): number {
  if (clusterBytes <= 0) return files.reduce((total, file) => total + file.size, 0)
  return files.reduce(
    (total, file) => total + Math.ceil(file.size / clusterBytes) * clusterBytes,
    0,
  )
}

// ---------------------------------------------------------------------------
// The tree, and leaving things out of it
// ---------------------------------------------------------------------------

export type TreeNode = {
  /** `/`-separated, relative to the destination root. */
  path: string
  name: string
  directory: boolean
  /** Total size of this file, or of everything beneath this folder. */
  size: number
  /** How many files are here or beneath. */
  files: number
  children: TreeNode[]
}

/** Builds the folder tree a picker draws, sorted folders first then by name. */
export function treeOf(files: readonly HeldFile[]): TreeNode[] {
  const root: TreeNode = {
    path: '',
    name: '',
    directory: true,
    size: 0,
    files: 0,
    children: [],
  }

  for (const file of files) {
    const parts = file.relativePath.split('/').filter(Boolean)
    let node = root
    parts.forEach((part, index) => {
      const last = index === parts.length - 1
      const path = parts.slice(0, index + 1).join('/')
      let child = node.children.find((entry) => entry.name === part)
      if (!child) {
        child = {
          path,
          name: part,
          directory: !last,
          size: 0,
          files: 0,
          children: [],
        }
        node.children.push(child)
      }
      child.size += file.size
      child.files += 1
      node = child
    })
    root.size += file.size
    root.files += 1
  }

  const order = (nodes: TreeNode[]) => {
    nodes.sort(
      (left, right) =>
        Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name),
    )
    for (const node of nodes) order(node.children)
  }
  order(root.children)
  return root.children
}

/**
 * True when a path is left out, either itself or by a folder above it.
 *
 * Unticking a folder leaves everything inside it out, which is what somebody
 * means by unticking a folder — enumerating its contents into the set instead
 * would make the tick boxes disagree with themselves as soon as anything moved.
 */
export function isExcluded(relativePath: string, excluded: ReadonlySet<string>): boolean {
  if (!excluded.size) return false
  if (excluded.has(relativePath)) return true
  const parts = relativePath.split('/')
  for (let depth = 1; depth < parts.length; depth += 1) {
    if (excluded.has(parts.slice(0, depth).join('/'))) return true
  }
  return false
}

/** The files that would actually be written. */
export function keptFiles(
  files: readonly HeldFile[],
  excluded: ReadonlySet<string>,
): HeldFile[] {
  return files.filter((file) => !isExcluded(file.relativePath, excluded))
}

// ---------------------------------------------------------------------------
// Choosing what to leave out
// ---------------------------------------------------------------------------

/**
 * Words that name a disk you need once and never at the machine.
 *
 * Whole words only, for the same reason categories are read that way: "Install"
 * is a setup disk and "Installer Demo" is a demo about one, but "Preinstalled"
 * is neither and must not be caught.
 */
const SETUP_WORDS = [
  'install',
  'installer',
  'installation',
  'setup',
  'boot',
  'bootdisk',
  'workbench',
  'kickstart',
  'driver',
  'drivers',
  'diagnostic',
  'diagnostics',
  'system',
  'os',
  'update',
  'patch',
]

/**
 * The top-level folders, in the order they should be given up.
 *
 * Ordered by how likely somebody is to want the thing at a real machine: system
 * and setup material first, then applications and reference, and games last,
 * because a games stick without games is not a stick anybody asked for. A
 * folder nothing recognises sits between the two, ordered by size so the
 * largest unknown goes before the smallest known.
 */
const FOLDER_ORDER = [
  'System',
  'Utils',
  'Edu',
  'Mags',
  'Music',
  'Apps',
  'Demos',
  'Unsorted',
  'Games',
]

export function foldersByPriority(files: readonly HeldFile[]): string[] {
  const sizes = new Map<string, number>()
  for (const file of files) {
    const folder = file.relativePath.includes('/') ? file.relativePath.split('/')[0] : ''
    if (!folder) continue
    sizes.set(folder, (sizes.get(folder) ?? 0) + file.size)
  }
  return [...sizes.keys()].sort((left, right) => {
    const ranked = (name: string) => {
      const known = FOLDER_ORDER.indexOf(name)
      return known < 0 ? FOLDER_ORDER.indexOf('Unsorted') : known
    }
    return ranked(left) - ranked(right) || (sizes.get(right) ?? 0) - (sizes.get(left) ?? 0)
  })
}

/** True when a name says it is setup or system material. */
export function looksLikeSetup(relativePath: string): boolean {
  const words = wordsOf(readTags(relativePath.split('/').pop() ?? '').bareTitle)
  return SETUP_WORDS.some((word) => words.includes(` ${word} `))
}

/**
 * The set a file belongs to, so the discs of one title travel together.
 *
 * Taken from the written name rather than the library, because by this point
 * the library is not in hand — the destination is. A name written by this
 * application ends in its disc marker, which is exactly what has to come off to
 * find the title.
 */
export function titleOf(relativePath: string): string {
  const folder = relativePath.slice(0, relativePath.lastIndexOf('/') + 1)
  const name = relativePath.slice(folder.length)
  const tags = readTags(name)
  return `${folder}${tags.bareTitle.toLowerCase()}`
}

export type Proposal = {
  /** Paths to leave out of this write. */
  excluded: Set<string>
  /** What it did, in the order it did it, for the interface to show. */
  steps: string[]
  /** Whether it managed to make the collection fit. */
  fits: boolean
  keptBytes: number
}

/**
 * Proposes what to leave out, in order, stopping as soon as it fits.
 *
 * It proposes and never decides: the caller shows these choices already made
 * and lets every one of them be put back. Each rule is a guess about intent,
 * and a guess applied silently is how somebody ends up at a machine without the
 * disk they wanted.
 *
 * Whole titles go, never single discs: a game missing a disc is dead weight, so
 * dropping any disc drops its set.
 */
export function proposeExclusions(
  files: readonly HeldFile[],
  profile: Profile,
  capacity: Capacity,
  /** Categories the user asked to drop outright, by top-level folder name. */
  dropFolders: readonly string[] = [],
): Proposal {
  const excluded = new Set<string>()
  const steps: string[] = []
  const accepted = acceptedFormats(profile.platformId, profile.firmwareId)

  const remaining = () => keptFiles(files, excluded)
  const cost = () => costOf(remaining(), capacity.clusterBytes)
  // An empty stick is not a stick that fits. Dropping everything would satisfy
  // the arithmetic and defeat the purpose, so the proposal only ever counts as
  // fitting while it still has something to write.
  const fits = () => remaining().length > 0 && cost() <= capacity.usableBytes

  /** Drops whole titles, so a set never loses one of its discs. */
  const dropTitles = (matching: (file: HeldFile) => boolean, reason: string) => {
    if (fits()) return
    const doomed = new Set(
      files.filter((file) => matching(file)).map((file) => titleOf(file.relativePath)),
    )
    if (!doomed.size) return
    // Never the last thing on the stick: a step that would leave nothing to
    // write is not a step towards fitting, it is giving up with extra effort.
    const survivors = files.filter(
      (file) =>
        !doomed.has(titleOf(file.relativePath)) && !isExcluded(file.relativePath, excluded),
    )
    if (!survivors.length) return
    const before = cost()
    for (const file of files) {
      if (doomed.has(titleOf(file.relativePath))) excluded.add(file.relativePath)
    }
    const freed = before - cost()
    // The size is the point: "1,142 titles" is a number, "1.7 GB" is the reason
    // it was worth giving up, and somebody deciding whether to put it back
    // needs the second one.
    if (freed > 0) steps.push(`${reason}: ${doomed.size} titles, ${formatBytes(freed)}`)
  }

  // 1. Anything this drive cannot load is a copy of something it cannot show.
  //    Firmware configuration is exempt: without it the stick will not behave.
  dropTitles(
    (file) =>
      !file.relativePath.toLowerCase().endsWith('.cfg') &&
      accepted.length > 0 &&
      !accepted.includes(dottedExtensionOf(file.relativePath)),
    'Formats this drive cannot load',
  )

  // 2. Setup and system material: needed once, never at the machine.
  dropTitles(
    (file) =>
      looksLikeSetup(file.relativePath) ||
      categoryIn(file.relativePath.split('/')[0] ?? '') === 'system',
    'Setup and system disks',
  )

  // 3. Whole categories the user named, before anything it picks itself.
  for (const folder of dropFolders) {
    dropTitles(
      (file) => file.relativePath.split('/')[0] === folder,
      `Everything under ${folder}`,
    )
  }

  // 4. Then whole categories of its own choosing, least wanted at a machine
  //    first. Stopping at step two and announcing that it does not fit is not
  //    help: the whole point of asking is to be given something that fits, and
  //    a category is the largest thing that can go without breaking anything.
  //    Games are last because they are almost always the reason for the stick.
  for (const folder of foldersByPriority(files)) {
    if (fits()) break
    dropTitles(
      (file) => file.relativePath.split('/')[0] === folder,
      `Everything under ${folder}`,
    )
  }

  return { excluded, steps, fits: fits(), keptBytes: cost() }
}

// ---------------------------------------------------------------------------
// How a stick should be written to
// ---------------------------------------------------------------------------

/** Filesystems a GoTek can read, as the operating system names them. */
const FAT_FILESYSTEMS = ['vfat', 'fat', 'fat12', 'fat16', 'fat32', 'msdos', 'exfat']

/**
 * Where a device can simply be written to, if it can.
 *
 * A stick already formatted for a GoTek and mounted by the desktop is an
 * ordinary folder, and copying files into it is the whole job: only what is
 * missing moves, an interrupted copy leaves one obvious partial file, and
 * nothing has to be erased. Building an image of the entire device and writing
 * it back byte for byte is how you *format* a stick, which is a different
 * question and a far more expensive answer: eight gigabytes of reading and
 * writing to deliver one gigabyte of games.
 *
 * So this asks the cheaper question first. `undefined` means the device cannot
 * be written to as a folder, and has to be formatted before it can hold
 * anything.
 */
export function writableMount(device: {
  partitions: ReadonlyArray<{
    filesystem?: string | null
    mountPoints?: readonly string[]
  }>
}): string | undefined {
  for (const partition of device.partitions) {
    const kind = (partition.filesystem ?? '').toLowerCase()
    if (!FAT_FILESYSTEMS.includes(kind)) continue
    const mount = (partition.mountPoints ?? []).find((path) => path && path !== '[SWAP]')
    if (mount) return mount
  }
  return undefined
}
