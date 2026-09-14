/**
 * Checking for, downloading and installing a newer GoTek Manager, as the About
 * box shows it.
 *
 * Every step is a pure function from what happened to what the box shows, so
 * the wording and the buttons can be checked without a window or a network.
 * The backend decides which release is newer and which file this copy needs;
 * this only says so.
 *
 * The wording is kept the same as in the other applications by the same
 * author, so an update reads alike in all of them.
 */

import { formatBytes } from './media'
import type { AvailableUpdate, InstallOutcome, UpdateCheck, UpdateMethod } from './types'

export const APPLICATION_NAME = 'GoTek Manager'
export const CHECK_LABEL = 'Check for Application Updates'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'confirming'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'opened'
  | 'failed'

export type AppUpdateState = {
  phase: UpdatePhase
  message: string
  /** The version running now, once a check has said. */
  current?: string
  update?: AvailableUpdate
}

export const IDLE: AppUpdateState = { phase: 'idle', message: '' }

/** Whether the update is doing something that must be waited for. */
export function isBusy(state: AppUpdateState): boolean {
  return ['checking', 'downloading', 'installing'].includes(state.phase)
}

/** Whether this copy can install `update` itself, rather than be sent to the release page. */
export function isInstallable(update: AvailableUpdate): boolean {
  return Boolean(update.method && update.asset && !update.blocked)
}

export function checking(): AppUpdateState {
  return { phase: 'checking', message: 'Asking GitHub for the newest version' }
}

export function checked(result: UpdateCheck): AppUpdateState {
  const { current, update } = result
  if (!update) {
    return {
      phase: 'current',
      current,
      message: `${APPLICATION_NAME} ${current} is the newest version`,
    }
  }
  return { phase: 'available', current, update, message: availableText(update, current) }
}

/** A check that could not be answered, which never reads as "the newest". */
export function checkFailed(reason: string): AppUpdateState {
  return { phase: 'failed', message: `Could not check for a newer version: ${reason}` }
}

function availableText(update: AvailableUpdate, current: string): string {
  const text = `${update.name} is available. You have version ${current}.`
  return update.blocked ? `${text} ${update.blocked}` : text
}

/** The update on offer again, with why it was not installed, or what it is. */
export function offered(state: AppUpdateState, message?: string): AppUpdateState {
  const { update, current = '' } = state
  if (!update) return IDLE
  return {
    phase: 'available',
    current,
    update,
    message: message ?? availableText(update, current),
  }
}

const WHAT: Record<UpdateMethod, string> = {
  apt: 'package',
  dnf: 'package',
  appImage: 'AppImage',
  installer: 'installer',
  diskImage: 'disk image',
}

/** What pressing Update does, said before anything is downloaded. */
export function confirmText(update: AvailableUpdate, current: string): string {
  const size = update.size ? ` (${formatBytes(update.size)})` : ''
  const file = `${update.asset ?? ''}${size}`
  const fetched = `is downloaded from GitHub, checked against the release's SHA256SUMS file`
  const how: Record<UpdateMethod, string> = {
    apt: `The Debian package ${file} ${fetched} and installed with apt, which asks for your password.`,
    dnf: `The RPM package ${file} ${fetched} and installed with dnf, which asks for your password.`,
    appImage: `The AppImage ${file} ${fetched} and put in place of ${update.replaces ?? 'this one'}.`,
    installer: `The installer ${file} ${fetched} and started, and ${APPLICATION_NAME} closes so that the installer can replace it.`,
    diskImage: `The disk image ${file} ${fetched} and opened, for you to drag the new ${APPLICATION_NAME} into Applications.`,
  }
  const method = update.method ?? 'apt'
  return (
    `Version ${update.version} is available; you have ${current}. ${how[method]} ` +
    'Your settings, profiles and library are kept.'
  )
}

export function confirming(state: AppUpdateState): AppUpdateState {
  const { update, current = '' } = state
  if (!update || !isInstallable(update)) return state
  return { phase: 'confirming', current, update, message: confirmText(update, current) }
}

export function downloading(state: AppUpdateState): AppUpdateState {
  const what = WHAT[state.update?.method ?? 'apt']
  return { ...state, phase: 'downloading', message: `Downloading the ${what}` }
}

export function installing(state: AppUpdateState): AppUpdateState {
  const { update } = state
  const name = update?.name ?? APPLICATION_NAME
  const message: Record<UpdateMethod, string> = {
    apt: `Installing ${name}. The system asks for your password.`,
    dnf: `Installing ${name}. The system asks for your password.`,
    appImage: `Installing ${name}.`,
    installer: `Starting the installer. ${APPLICATION_NAME} closes so that it can be replaced.`,
    diskImage: `Opening the disk image for ${name}.`,
  }
  return { ...state, phase: 'installing', message: message[update?.method ?? 'apt'] }
}

export function afterInstall(state: AppUpdateState, outcome: InstallOutcome): AppUpdateState {
  const name = state.update?.name ?? APPLICATION_NAME
  switch (outcome.outcome) {
    case 'restart':
      return {
        ...state,
        phase: 'installed',
        message: `${name} is installed. Restart ${APPLICATION_NAME} to use it.`,
      }
    case 'opened':
      return {
        ...state,
        phase: 'opened',
        message:
          `The disk image for ${name} is open. Quit ${APPLICATION_NAME}, drag the new copy ` +
          'into Applications to replace this one, then start it again.',
      }
    case 'handover':
      return { ...state, phase: 'installing', message: 'The installer is running.' }
    case 'held':
      return offered(state, outcome.message)
  }
}

/** A download or install that went wrong, with the release page still offered. */
export function updateFailed(state: AppUpdateState, reason: string): AppUpdateState {
  return { ...state, phase: 'failed', message: `The update failed: ${reason}` }
}

/** How much of the download has arrived, in words. */
export function downloadText(done: number, total?: number | null): string {
  return total ? `${formatBytes(done)} of ${formatBytes(total)}` : formatBytes(done)
}

export type UpdateAction = 'check' | 'confirm' | 'page' | 'restart' | 'quit'

/** The controls the About box shows for `state`. */
export type UpdateControls = {
  /** The main button, when there is one. */
  primary?: { label: string; action: UpdateAction; suggested: boolean }
  /** A separate Release Page button. */
  releasePage: boolean
  /** Download progress, with Cancel. */
  progress: boolean
  /** Waiting for something that cannot be cancelled. */
  spinner: boolean
}

export function controlsFor(state: AppUpdateState): UpdateControls {
  const { phase, update } = state
  const hasPage = Boolean(update?.pageUrl)
  const controls: UpdateControls = {
    releasePage: hasPage && phase !== 'installed' && phase !== 'opened',
    progress: phase === 'downloading',
    spinner: phase === 'installing',
  }
  switch (phase) {
    case 'downloading':
    case 'installing':
    case 'confirming':
      return controls
    case 'checking':
      return { ...controls, primary: { label: 'Checking', action: 'check', suggested: false } }
    case 'available':
      if (update && isInstallable(update)) {
        const label = `Update to ${update.version}`
        return { ...controls, primary: { label, action: 'confirm', suggested: true } }
      }
      return {
        ...controls,
        releasePage: false,
        primary: { label: 'Open Release Page', action: 'page', suggested: false },
      }
    case 'installed':
      return {
        ...controls,
        primary: { label: `Restart ${APPLICATION_NAME}`, action: 'restart', suggested: true },
      }
    case 'opened':
      return {
        ...controls,
        primary: { label: `Quit ${APPLICATION_NAME}`, action: 'quit', suggested: true },
      }
    default:
      return { ...controls, primary: { label: CHECK_LABEL, action: 'check', suggested: false } }
  }
}
