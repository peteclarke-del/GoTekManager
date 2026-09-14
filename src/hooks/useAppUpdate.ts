/**
 * The application update, held for the whole window rather than by the About
 * box.
 *
 * Closing the About box therefore does not stop a download, reopening it shows
 * how far the download has got, and an update cannot be started twice. Nothing
 * is checked until the user presses Check for Application Updates.
 */

import { useCallback, useRef, useState } from 'react'
import {
  afterInstall,
  checkFailed,
  checked,
  checking,
  confirming,
  downloading,
  IDLE,
  installing,
  isBusy,
  offered,
  updateFailed,
  type AppUpdateState,
} from '../domain/appUpdate'
import type { UpdateProgress } from '../domain/types'
import {
  cancelUpdate,
  checkForUpdate,
  downloadUpdate,
  errorMessage,
  installUpdate,
  openExternal,
  quitApp,
  restartApp,
  UPDATE_PROGRESS_EVENT,
} from '../native/commands'
import { useNativeEvent } from './useNativeEvent'

export type AppUpdater = ReturnType<typeof useAppUpdate>

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState>(IDLE)
  // Read by the steps below after each await, where the state they closed
  // over is already out of date.
  const latest = useRef(state)
  const progress = useNativeEvent<UpdateProgress>(UPDATE_PROGRESS_EVENT, (payload) => payload)

  const show = useCallback((next: AppUpdateState) => {
    latest.current = next
    setState(next)
  }, [])

  const check = useCallback(async () => {
    if (isBusy(latest.current)) return
    show(checking())
    try {
      show(checked(await checkForUpdate()))
    } catch (reason) {
      show(checkFailed(errorMessage(reason)))
    }
  }, [show])

  const confirm = useCallback(() => show(confirming(latest.current)), [show])

  const back = useCallback(() => show(offered(latest.current)), [show])

  const install = useCallback(async () => {
    if (latest.current.phase !== 'confirming') return
    show(downloading(latest.current))
    try {
      const fetched = await downloadUpdate()
      if (fetched.outcome === 'held') {
        show(offered(latest.current, fetched.message))
        return
      }
      show(installing(latest.current))
      show(afterInstall(latest.current, await installUpdate()))
    } catch (reason) {
      show(updateFailed(latest.current, errorMessage(reason)))
    }
  }, [show])

  const cancel = useCallback(() => void cancelUpdate(), [])

  const openPage = useCallback(() => {
    const url = latest.current.update?.pageUrl
    if (url) void openExternal(url)
  }, [])

  // Restarting or closing is refused while media is being written, and says so.
  const leave = useCallback(
    async (how: () => Promise<void>) => {
      try {
        await how()
      } catch (reason) {
        show({ ...latest.current, message: errorMessage(reason) })
      }
    },
    [show],
  )
  const restart = useCallback(() => void leave(restartApp), [leave])
  const quit = useCallback(() => void leave(quitApp), [leave])

  return { state, progress, check, confirm, back, install, cancel, openPage, restart, quit }
}
