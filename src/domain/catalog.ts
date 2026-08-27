/**
 * The platform and firmware catalogue.
 *
 * A GoTek emulates a **floppy drive**. Only formats that describe a floppy disk
 * can be presented to the host machine, so tape images (`.tap`, `.tzx`,
 * `.uef`), bare program and cartridge files (`.prg`, `.crt`, `.nex`), and flux
 * or copy-protection preservation formats (`.ipf`, `.atx`) are deliberately
 * absent: no GoTek firmware can load them from the stick.
 *
 * Which formats actually work depends on **both** the machine and the firmware,
 * so the two are modelled separately and the accepted list is their
 * intersection. For example FlashFloppy loads Atari 8-bit `.atr` directly while
 * HxC does not, and `.msa`, `.scl`, `.d64`, and `.ipf` must be converted to
 * `.hfe` on a computer before either firmware can use them.
 *
 * Sources:
 * - FlashFloppy image formats: https://github.com/keirf/flashfloppy/wiki/Image-Formats
 * - HxC Gotek firmware: https://hxc2001.com/docs/gotek-floppy-emulator-hxc-firmware/pages/emulation-from-images.html
 */

export type Platform = {
  id: string
  name: string
  family: string
  /** Short folder name used by the platform layout, kept OLED-friendly. */
  folderName: string
  /**
   * Floppy image formats this machine uses. What a given drive can actually
   * load is this list intersected with its firmware's — see
   * {@link acceptedFormats}.
   */
  formats: string[]
  firmwareIds: string[]
}

export type FirmwareProfile = {
  id: string
  name: string
  family: string
  /** Characters the drive's display can show, used for OLED naming. */
  oledLength: number
  /** Formats the firmware loads directly from the USB stick. */
  formats: string[]
  notes: string
}

/** The universal container every modern GoTek firmware understands. */
const HFE = '.hfe'

export const firmwareProfiles: FirmwareProfile[] = [
  {
    id: 'flashfloppy',
    name: 'FlashFloppy',
    family: 'Open source',
    oledLength: 24,
    formats: [
      HFE,
      '.adf', '.adl', '.adm', '.ssd', '.dsd',
      '.atr',
      '.d81',
      '.dsk', '.img', '.ima', '.xdf',
      '.st',
      '.trd', '.mgt', '.opd', '.mbd',
      '.sdu', '.fdi', '.hdm', '.jvc', '.vdk', '.v9t9', '.out',
    ],
    notes:
      'The broadest direct format support. Indexed and direct-access layouts, depending on host and configuration.',
  },
  {
    id: 'hxc',
    name: 'HxC',
    family: 'HxC',
    oledLength: 24,
    formats: [
      HFE,
      '.adf', '.adl', '.adm', '.ssd', '.dsd',
      '.d81',
      '.dsk', '.img', '.ima',
      '.st',
      '.trd', '.sdd', '.mgt', '.sad', '.opd',
      '.ldf', '.fd', '.do', '.po', '.v9t9', '.fdi', '.out', '.w30',
    ],
    notes:
      'Anything it cannot load directly can be converted to .hfe with the HxC desktop software first.',
  },
  {
    id: 'gotek-standard',
    name: 'GoTek Standard',
    family: 'Factory',
    oledLength: 8,
    // Factory firmware reads only raw sector images written into its own
    // indexed layout by the bundled USB tool.
    formats: ['.img', '.ima'],
    notes:
      'Factory firmware varies by model and reads only raw sector images in its own indexed layout. Verify the exact drive before provisioning.',
  },
]

export const platforms: Platform[] = [
  // Acorn: DFS single/double-sided and ADFS large/medium images.
  { id: 'bbc', name: 'Acorn BBC Micro', family: 'Acorn', folderName: 'BBC', formats: ['.ssd', '.dsd', '.adf', '.adl', '.adm', '.img', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
  { id: 'electron', name: 'Acorn Electron', family: 'Acorn', folderName: 'Electron', formats: ['.ssd', '.dsd', '.adf', '.adl', '.adm', '.img', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
  // Amstrad: CPC (E)DSK, plus raw images for factory firmware.
  { id: 'cpc464', name: 'Amstrad CPC464', family: 'Amstrad', folderName: 'CPC464', formats: ['.dsk', '.img', HFE], firmwareIds: ['flashfloppy', 'hxc', 'gotek-standard'] },
  { id: 'cpc6128', name: 'Amstrad CPC6128', family: 'Amstrad', folderName: 'CPC6128', formats: ['.dsk', '.img', HFE], firmwareIds: ['flashfloppy', 'hxc', 'gotek-standard'] },
  // Commodore 8-bit: only the 1581 uses a standard MFM 3.5" mechanism. The
  // 1541 and 1571 record GCR over a serial bus, which a GoTek cannot emulate,
  // so .d64, .g64, and .d71 are not listed.
  { id: 'plus4', name: 'Commodore Plus/4', family: 'Commodore', folderName: 'Plus4', formats: ['.d81', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
  { id: 'c64', name: 'Commodore 64', family: 'Commodore', folderName: 'C64', formats: ['.d81', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
  { id: 'c128', name: 'Commodore 128', family: 'Commodore', folderName: 'C128', formats: ['.d81', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
  { id: 'amiga', name: 'Commodore Amiga', family: 'Commodore', folderName: 'Amiga', formats: ['.adf', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
  // Sinclair: the 48K needs a disc interface, so its formats are the interface
  // formats. The +3 uses 3" CPC-style (E)DSK.
  { id: 'spectrum48', name: 'Sinclair Spectrum 48K', family: 'Sinclair', folderName: 'Spectrum48', formats: ['.trd', '.mgt', '.opd', '.mbd', '.sad', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
  { id: 'spectrum128', name: 'Spectrum 128K / +2 / +3', family: 'Sinclair', folderName: 'Spectrum128', formats: ['.dsk', '.trd', '.mgt', '.opd', '.mbd', '.sad', '.img', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
  { id: 'next', name: 'Spectrum Next', family: 'Sinclair', folderName: 'SpectrumNext', formats: ['.img', '.ima', '.dsk', '.trd', '.mgt', HFE], firmwareIds: ['flashfloppy', 'hxc', 'gotek-standard'] },
  // Atari ST: .msa is a compressed archive that neither firmware reads
  // directly; convert it to .st or .hfe first.
  { id: 'atari-st', name: 'Atari ST', family: 'Atari', folderName: 'AtariST', formats: ['.st', '.img', HFE], firmwareIds: ['flashfloppy', 'hxc', 'gotek-standard'] },
  // Atari 8-bit: FlashFloppy reads .atr directly; HxC needs it converted, which
  // the firmware intersection expresses on its own.
  { id: 'atari-8bit', name: 'Atari 8-bit', family: 'Atari', folderName: 'Atari8bit', formats: ['.atr', HFE], firmwareIds: ['flashfloppy', 'hxc'] },
]

/** Every recognised format, dotted and lowercase. */
export const supportedExtensions: ReadonlySet<string> = new Set(
  platforms.flatMap((platform) => platform.formats),
)

/** The same list in the form the native commands expect. */
export const supportedExtensionList: string[] = [...supportedExtensions]

export function platformById(id: string | undefined): Platform | undefined {
  return platforms.find((platform) => platform.id === id)
}

export function firmwareById(id: string | undefined): FirmwareProfile | undefined {
  return firmwareProfiles.find((firmware) => firmware.id === id)
}

/** Lookup that always yields a platform, so callers need no fallback of their own. */
export function requirePlatform(id: string | undefined): Platform {
  return platformById(id) || platforms[0]
}

export function requireFirmware(id: string | undefined): FirmwareProfile {
  return firmwareById(id) || firmwareProfiles[0]
}

/**
 * The formats a machine and a firmware can agree on.
 *
 * This is the honest answer to "what can I put on this drive?", and it is
 * narrower than either list alone. An empty result means the pairing cannot
 * load anything directly and the images need converting to `.hfe` first.
 */
export function acceptedFormats(
  platformId: string | undefined,
  firmwareId: string | undefined,
): string[] {
  const firmware = requireFirmware(firmwareId)
  return requirePlatform(platformId).formats.filter((format) =>
    firmware.formats.includes(format),
  )
}

/** True when a dotted extension is recognised by any platform. */
export function isSupportedExtension(dotted: string): boolean {
  return supportedExtensions.has(dotted.toLowerCase())
}

/**
 * Guesses a platform from a free-text name, used only to pre-fill a new
 * profile. The user can always change it.
 */
export function inferPlatformId(name: string): string {
  const normalised = name.toLowerCase()
  const match = platforms.find((platform) =>
    [platform.name, platform.family, platform.folderName].some((label) =>
      normalised.includes(label.toLowerCase()),
    ),
  )
  return (match || platforms[0]).id
}
