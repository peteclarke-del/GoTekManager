/**
 * Development-only harness that walks the application through the guided flow
 * so the help screenshots can be captured automatically.
 *
 * It drives the real interface by clicking the real controls against real
 * fixture folders through the real native commands, so the images are genuine
 * screenshots rather than mock-ups. Nothing here is a shortcut past the UI: if
 * a button is disabled, the harness waits for it exactly as a person would.
 *
 * The whole module is inert unless `VITE_CAPTURE` is set during `npm run dev`,
 * and `import.meta.env.DEV` is statically false in a production build, so none
 * of it reaches a packaged application.
 *
 * Run it through `scripts/capture-screenshots.sh`, which creates the fixtures,
 * serves the capture endpoint, and starts the app.
 */

import { useEffect, useRef } from 'react'
import { classifyMedia } from '../domain/media'
import { basename } from '../domain/paths'
import type { AppSettings, Page, ThemeChoice } from '../domain/types'
import { scanFolder } from '../native/commands'
import type { WorkspaceAction } from '../state/workspace'
import { createProfile } from '../state/workspace'

export type CaptureControls = {
  dispatch: React.Dispatch<WorkspaceAction>
  setPage: (page: Page) => void
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>
  /** Profiles already persisted, cleared so each run starts from a known state. */
  existingProfileIds: string[]
}

const enabled = import.meta.env.DEV && Boolean(import.meta.env.VITE_CAPTURE)

const config = {
  library: String(import.meta.env.VITE_CAPTURE_LIBRARY || ''),
  destination: String(import.meta.env.VITE_CAPTURE_DESTINATION || ''),
  secondDestination: String(import.meta.env.VITE_CAPTURE_DESTINATION_2 || ''),
  endpoint: String(import.meta.env.VITE_CAPTURE_ENDPOINT || 'http://127.0.0.1:8791'),
  theme: (import.meta.env.VITE_CAPTURE_THEME || 'light') as ThemeChoice,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits for the interface to satisfy a condition, or gives up loudly. */
async function waitFor<T>(
  describe: string,
  probe: () => T | null | undefined | false,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value as T
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describe}`)
    await sleep(100)
  }
}

function visibleButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
}

/** Finds an enabled button by its visible label. */
function button(label: string): HTMLButtonElement | undefined {
  return visibleButtons().find(
    (candidate) => !candidate.disabled && candidate.textContent?.trim().startsWith(label),
  )
}

async function click(label: string) {
  const target = await waitFor(`the “${label}” button to become available`, () => button(label))
  target.click()
}

/**
 * Sets a React-controlled input.
 *
 * Assigning `value` directly would not notify React, so the native setter is
 * used and an input event dispatched, which is what a real keystroke produces.
 */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Asks the capture server for a screenshot and waits until it has taken one. */
async function capture(name: string) {
  // Two frames plus a beat lets transitions and any pending paint settle.
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
  await sleep(400)
  const response = await fetch(`${config.endpoint}/capture/${name}`)
  if (!response.ok) throw new Error(`Capture of ${name} failed: ${response.status}`)
}

async function seed({ dispatch, setSettings, existingProfileIds }: CaptureControls) {
  setSettings((current) => ({ ...current, theme: config.theme }))

  // Each run starts from a known state, so a screenshot can never show a
  // leftover profile or title from an earlier capture.
  dispatch({ type: 'libraryCleared' })
  for (const id of existingProfileIds) dispatch({ type: 'profileRemoved', id })

  const entries = await scanFolder(config.library)
  const source = {
    id: `source:${config.library}`,
    name: basename(config.library),
    path: config.library,
  }
  const items = entries.map((entry) => classifyMedia(entry, config.library))
  dispatch({ type: 'sourceIndexed', source, items })

  const defaults = {
    firmwareId: 'flashfloppy',
    organise: true,
    folderLayout: 'platform' as const,
    naming: 'oled' as const,
  }

  // A second profile, so the profile list reads like a real workspace rather
  // than a single lonely entry. Added first, leaving the BBC one selected.
  if (config.secondDestination) {
    const other = createProfile(
      { kind: 'volume', path: config.secondDestination, removable: true },
      { ...defaults, naming: 'original' },
      'CPC 6128',
    )
    dispatch({ type: 'profileAdded', profile: { ...other, platformId: 'cpc6128' } })
  }

  const profile = createProfile(
    { kind: 'volume', path: config.destination, removable: true },
    defaults,
    'BBC GOTEK',
  )
  dispatch({ type: 'profileAdded', profile: { ...profile, platformId: 'bbc' } })

  // Stage a few titles that are not already on the destination.
  const staged = items
    .filter((item) => item.extension === 'ssd')
    .slice(0, 4)
    .map((item) => ({ ...item, assignedPlatformId: 'bbc' }))
  dispatch({ type: 'collectionAdded', profileId: profile.id, items: staged })

  return profile
}

async function walkTheFlow(controls: CaptureControls) {
  const profile = await seed(controls)

  // 1 · Profile
  await waitFor('the profile step', () => document.querySelector('.flow-profile'))
  await capture('01-profile')

  // 2 · Current contents
  await click('View contents')
  await waitFor('the destination browser', () => document.querySelector('.destination-browser'))
  await capture('02-contents')

  // 3 · Sources
  await click('Choose sources')
  await waitFor('the library table', () => document.querySelector('.library-table tbody tr'))
  await capture('03-sources')

  // 4 · Verify
  await click('Verify changes')
  await waitFor('the planned result', () => document.querySelector('.build-result-table tbody tr'))
  await capture('04-verify')

  // 5 · Confirm
  await click('Confirm changes')
  const input = await waitFor('the confirmation field', () =>
    document.querySelector<HTMLInputElement>('.build-review-confirm input'),
  )
  type(input, profile.name)
  await waitFor('the apply button to unlock', () => button('Apply to GoTek'))
  await capture('05-confirm')

  // 6 · Summary
  await click('Apply to GoTek')
  await waitFor('the summary', () => document.querySelector('.flow-summary'))
  await capture('06-summary')

  // The profiles screen
  controls.setPage('Profiles')
  await waitFor('the profiles screen', () => document.querySelector('.target-view'))
  await capture('07-profiles')

  if (import.meta.env.VITE_CAPTURE_HELP) {
    controls.setPage('Help')
    await waitFor('the help screen', () => document.querySelector('.help-shots img'))
    await sleep(1200)
    await capture('08-help')
  }

  await fetch(`${config.endpoint}/done`)
}

export function useCaptureHarness(controls: CaptureControls) {
  const started = useRef(false)
  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true
    walkTheFlow(controls).catch(async (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      console.error('[capture]', message)
      await fetch(`${config.endpoint}/failed?reason=${encodeURIComponent(message)}`).catch(
        () => undefined,
      )
    })
    // The harness runs once for the lifetime of the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
