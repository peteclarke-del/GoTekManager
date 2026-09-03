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
import type { DisplayType, Profile } from './types'

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

/**
 * How each display choice reads on screen.
 *
 * A GoTek fitted into a machine, or behind a remote control board, is often
 * mounted the only way it will fit, which leaves the panel upside down. The
 * firmware's answer is `-rotate`, and it only accepts it on a named panel:
 * `auto` cannot be rotated, so choosing rotation means saying which OLED is
 * fitted. The 0.91" panel most sticks ship with is 128x32; the taller 0.96"
 * one is 128x64.
 */
export const DISPLAY_CHOICES: Array<[DisplayType, string]> = [
  ['auto', 'Detect automatically (firmware default)'],
  ['oled-128x32', 'OLED 128x32'],
  ['oled-128x32-rotate', 'OLED 128x32, upside down'],
  ['oled-128x64', 'OLED 128x64'],
  ['oled-128x64-rotate', 'OLED 128x64, upside down'],
]

type Setting = { key: string; value: string; why: string[] }

/**
 * The display setting, when the profile names a panel.
 *
 * Nothing is written for `auto`, which is the firmware's own default: a drive
 * that detects its panel correctly must not be told something it then has to
 * live with.
 */
function displaySetting(profile: Profile): Setting[] {
  const display = profile.display
  if (!display || display === 'auto') return []
  const rotated = display.endsWith('-rotate')
  return [
    {
      key: 'display-type',
      value: display,
      why: rotated
        ? [
            'This drive reports its panel mounted upside down, so the view is',
            'rotated 180 degrees. Rotation can only be asked for on a named',
            'panel, which is why the size is spelled out rather than detected.',
          ]
        : [
            'The panel fitted to this drive, named rather than detected.',
          ],
    },
  ]
}

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

/** Everything this application is responsible for, for one profile. */
function ownedSettings(profile: Profile, platform: Platform): Setting[] {
  return [...settingsFor(platform), ...displaySetting(profile)]
}

/**
 * Plain ASCII, and nothing a drive's parser can trip over.
 *
 * This is parsed by an 8-bit drive, not by a text editor: a typographic dash is
 * three bytes there, and a profile named in another script must not be able to
 * produce a file the firmware chokes on.
 */
function ascii(text: string): string {
  return text.replace(/[^\t\x20-\x7e\n\r]/g, '?')
}

/**
 * This application's settings applied to a configuration file that already
 * exists, leaving everything else in it exactly as it was found.
 *
 * A stick that has been set up by hand is the normal case, not the exception: a
 * real `FF.CFG` carries an interface jumper, a display order, a font, a
 * contrast, a startup image — settings this application has no opinion about
 * and no business discarding. So the file is edited rather than replaced. A
 * setting this application owns has its value changed where the file already
 * names it, keeping the line's own spacing, and is appended with its reason
 * where it does not. Comments, blank lines, ordering, and the file's line
 * endings all survive.
 *
 * Every occurrence of an owned key is updated, not just the first: the firmware
 * reads the last assignment, so leaving a later one behind would silently undo
 * the change.
 */
export function mergeFlashFloppyConfig(
  existing: string,
  profile: Profile,
  platform: Platform,
): string {
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'
  const settings = ownedSettings(profile, platform)
  const seen = new Set<string>()

  const lines = existing.split(/\r?\n/).map((line) => {
    const match = /^(\s*)([A-Za-z0-9-]+)(\s*=\s*)(.*)$/.exec(line)
    if (!match) return line
    const [, indent, key, separator] = match
    const setting = settings.find((entry) => entry.key === key.toLowerCase())
    if (!setting) return line
    seen.add(setting.key)
    // Only the value is ours; the key and its spacing are the file's own.
    return `${indent}${key}${separator}${ascii(setting.value)}`
  })

  // A file that ends in a newline splits to a trailing empty line; adding after
  // it would leave a blank gap, so it is trimmed and restored at the end.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()

  const missing = settings.filter((setting) => !seen.has(setting.key))
  if (missing.length) {
    lines.push('', ascii(`# Added by GoTek Manager for "${profile.name}" (${platform.name}).`))
    for (const setting of missing) {
      lines.push('', ...setting.why.map((line) => ascii(`# ${line}`)))
      lines.push(`${setting.key} = ${ascii(setting.value)}`)
    }
  }

  return `${lines.join(newline)}${newline}`
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

  for (const setting of ownedSettings(profile, platform)) {
    lines.push('', ...setting.why.map((line) => `# ${line}`))
    lines.push(`${setting.key} = ${setting.value}`)
  }

  return `${ascii(lines.join('\n'))}\n`
}

/** The configuration a profile needs, or nothing when its firmware has none. */
export function configFor(profile: Profile, platform: Platform): string | null {
  return configSupport(profile.firmwareId).writable
    ? flashFloppyConfig(profile, platform)
    : null
}
