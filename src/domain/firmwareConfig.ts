/**
 * The configuration file a drive's firmware reads from the stick.
 *
 * A GoTek running FlashFloppy takes its settings from `FF.CFG`. Without one it
 * uses its defaults, and two of those defaults are wrong for the way this
 * application lays a stick out: the firmware will switch to indexed
 * `DSKA0000`-style names if it finds any, and it interprets generic images
 * without knowing what machine they came from.
 *
 * What is deliberately *not* written matters as much as what is. The drive
 * interface is left alone: its default follows the JC jumper on the board,
 * which is the Shugart wiring every machine this application prepares expects,
 * and overriding it in a file would break a drive that is jumpered correctly.
 * Nothing else is written either, so a setting the user has tuned by hand is
 * never quietly replaced by a default.
 *
 * The values here come from FlashFloppy's own documentation rather than from
 * habit; each is commented in the file it produces with the reason it is there.
 */

import type { Platform } from './catalog'
import type { Profile } from './types'

/** The file FlashFloppy reads. */
export const FLASHFLOPPY_CONFIG = 'FF.CFG'

/**
 * Whether a firmware has a configuration file this application can produce.
 *
 * HxC is the reason this is a question rather than an assumption: its
 * `HXCSDFE.CFG` is a binary file written by the HxC desktop software, holding a
 * slot table this application has no way to build. Producing something
 * plausible would be worse than producing nothing.
 */
export type ConfigSupport =
  | { writable: true; fileName: string }
  | { writable: false; reason: string }

export function configSupport(firmwareId: string): ConfigSupport {
  if (firmwareId === 'flashfloppy') return { writable: true, fileName: FLASHFLOPPY_CONFIG }
  if (firmwareId === 'hxc') {
    return {
      writable: false,
      reason:
        'HxC keeps its settings in HXCSDFE.CFG, a binary file written by the HxC desktop software. It cannot be produced here.',
    }
  }
  return {
    writable: false,
    reason:
      'Factory GoTek firmware has no configuration file; its layout is written by the bundled USB tool.',
  }
}

/** Machines whose images FlashFloppy reads better when told whose they are. */
const ACORN_PLATFORMS = new Set(['bbc', 'electron'])

type Setting = { key: string; value: string; why: string[] }

function settingsFor(platform: Platform): Setting[] {
  const settings: Setting[] = [
    {
      key: 'nav-mode',
      value: 'native',
      why: [
        'Browse the files and folders on this stick by name. Left at its',
        'default the firmware switches to indexed DSKA0000-style names as soon',
        'as it finds any, which would hide everything written here.',
      ],
    },
  ]

  if (ACORN_PLATFORMS.has(platform.id)) {
    settings.push({
      key: 'host',
      value: 'acorn',
      why: ['Read generic .img and .dsk images as Acorn ADFS rather than guessing.'],
    })
    settings.push({
      key: 'index-suppression',
      value: 'no',
      why: [
        'FlashFloppy documents this for the BBC Micro, whose disc interface',
        'needs the index pulse left alone. The Electron disc interfaces use',
        'the same controller.',
      ],
    })
  }

  return settings
}

/**
 * The contents of `FF.CFG` for a profile.
 *
 * Every line is either a comment or one setting, in the `key = value` form the
 * firmware's own example file uses.
 */
export function flashFloppyConfig(profile: Profile, platform: Platform): string {
  const lines = [
    `# FF.CFG - written by GoTek Manager for "${profile.name}" (${platform.name}).`,
    '#',
    '# FlashFloppy reads this from the root of the stick, or from an FF folder',
    '# if one exists. Only the settings below are set; everything else keeps its',
    '# firmware default, including the drive interface, which follows the JC',
    '# jumper on the board and is already right for this machine.',
  ]

  for (const setting of settingsFor(platform)) {
    lines.push('', ...setting.why.map((line) => `# ${line}`))
    lines.push(`${setting.key} = ${setting.value}`)
  }

  // Kept to plain ASCII, and to the line ending the firmware's own example
  // uses. This is parsed by an 8-bit drive, not by a text editor: a typographic
  // dash is three bytes there, and a profile named in another script must not
  // be able to produce a file the firmware chokes on.
  return `${lines.join('\n').replace(/[^\t\x20-\x7e\n]/g, '?')}\n`
}

/** The configuration a profile needs, or nothing when its firmware has none. */
export function configFor(profile: Profile, platform: Platform): string | null {
  return configSupport(profile.firmwareId).writable
    ? flashFloppyConfig(profile, platform)
    : null
}
