import { useCallback, useEffect, useState } from 'react'
import { FileCog } from 'lucide-react'
import type { Platform } from '../../domain/catalog'
import { configFor, configSupport } from '../../domain/firmwareConfig'
import type { FirmwareConfigState, Profile } from '../../domain/types'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { firmwareConfigState, writeFirmwareConfig } from '../../native/commands'

/**
 * The drive's own configuration file, shown before anything is written.
 *
 * A stick full of correctly named images still will not behave until the
 * firmware is told how to read it, and that was previously left for the user to
 * find out. The file is written with the rest of the transfer, but it is shown
 * here first — in full, on request — because a wrong setting in it stops a
 * drive working, and nobody should have to discover what was put on their stick
 * by reading it afterwards.
 *
 * One already on the drive is never replaced without being asked for. It may
 * have been tuned by hand for a machine this application knows nothing about.
 */
export function DriveConfiguration({
  profile,
  platform,
  /** Bumped after a write, so the panel reflects what is now on the drive. */
  refreshKey,
}: {
  profile: Profile
  platform: Platform
  refreshKey: number
}) {
  const [state, setState] = useState<FirmwareConfigState | null>(null)
  const [showing, setShowing] = useState(false)
  const action = useAsyncAction()

  const support = configSupport(profile.firmwareId)
  const wanted = configFor(profile, platform)
  const target = profile.destination.path

  const refresh = useCallback(() => {
    if (!support.writable) return
    firmwareConfigState(target).then(setState, () => setState(null))
  }, [support.writable, target, refreshKey])

  useEffect(refresh, [refresh])

  if (!support.writable) {
    return (
      <div className="drive-config">
        <b>
          <FileCog />
          Drive configuration
        </b>
        <p className="mode-note">{support.reason}</p>
      </div>
    )
  }

  const matches = state?.exists && state.contents === wanted
  const write = (replace: boolean) =>
    void action.run(async () => {
      await writeFirmwareConfig(target, wanted ?? '', replace)
      refresh()
    })

  return (
    <div className="drive-config">
      <b>
        <FileCog />
        Drive configuration
      </b>
      <p className="mode-note">
        {!state
          ? 'Checking the drive…'
          : matches
            ? `${state.path} on this drive already holds the settings ${platform.name} needs.`
            : state.exists
              ? `${state.path} is already on this drive and will be left alone. It may have been set up by hand.`
              : `${state.path} will be written when you apply, so the drive reads this stick the way ${platform.name} needs.`}
      </p>
      {action.error && <p className="inline-error">{action.error}</p>}
      <div className="drive-config-actions">
        <button className="button secondary compact" onClick={() => setShowing(!showing)}>
          {showing ? 'Hide the file' : 'Show the file'}
        </button>
        {state && !state.exists && (
          <button
            className="button secondary compact"
            disabled={action.busy}
            onClick={() => write(false)}
          >
            Write it now
          </button>
        )}
        {state?.exists && !matches && (
          <button
            className="button secondary compact"
            disabled={action.busy}
            onClick={() => write(true)}
          >
            Replace it
          </button>
        )}
      </div>
      {showing && <pre className="drive-config-file">{wanted}</pre>}
    </div>
  )
}
