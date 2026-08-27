/**
 * The screens illustrated in the in-app help.
 *
 * Single source of truth: the help page renders from this list, the capture
 * harness walks it, and `npm run check` asserts an image exists for every entry
 * in both palettes. Renaming or adding a screen without re-capturing therefore
 * fails the checks rather than silently shipping a missing image.
 */

export type HelpScreen = {
  /** Image basename under `public/help/<theme>/`. */
  name: string
  title: string
  detail: string
}

export const HELP_THEMES = ['light', 'dark'] as const

/** The six guided steps, in order. */
export const FLOW_SCREENS: HelpScreen[] = [
  {
    name: '01-profile',
    title: 'Select profile',
    detail: 'Platform, firmware, drive layout, and destination, kept together.',
  },
  {
    name: '02-contents',
    title: 'Current contents',
    detail: 'Browse the destination and stage moves, renames, or deletions.',
  },
  {
    name: '03-sources',
    title: 'Choose sources',
    detail: 'Add from indexed local locations or online catalogues.',
  },
  {
    name: '04-verify',
    title: 'Verify changes',
    detail: 'Compare the current contents, the changes, and the result.',
  },
  {
    name: '05-confirm',
    title: 'Confirm write',
    detail: 'Resolve conflicts and type the exact profile name.',
  },
  {
    name: '06-summary',
    title: 'Summary',
    detail: 'Verified success details, or a clear failure with retry actions.',
  },
]

export const PROFILES_SCREEN: HelpScreen = {
  name: '07-profiles',
  title: 'Profiles',
  detail: "Create, edit, and browse a profile's destination.",
}

export const ALL_HELP_SCREENS: HelpScreen[] = [...FLOW_SCREENS, PROFILES_SCREEN]
