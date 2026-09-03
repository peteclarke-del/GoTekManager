import { useCallback, useEffect, useState } from 'react'
import { FileCog } from 'lucide-react'
import type { Platform } from '../../domain/catalog'
import { configFor, configSupport, mergeFlashFloppyConfig } from '../../domain/firmwareConfig'
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
 * have been tuned by hand for a machine this application knows nothing about,
 * so the offer is to *update* it: the settings this application is responsible
 * for are changed in place and everything else in the file is left as it was.
 * Overwriting it outright stays available, and says so.
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

  // What the file would become with this application's settings applied and
  // everything else in it kept. A file that already carries them merges to
  // itself, which is exactly "nothing to do".
  const merged =
    state?.exists && state.contents && wanted
      ? mergeFlashFloppyConfig(state.contents, profile, platform)
      : wanted
  const matches = Boolean(state?.exists && merged === state.contents)
  const write = (contents: string, replace: boolean) =>
    void action.run(async () => {
      await writeFirmwareConfig(target, contents, replace)
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
              ? `${state.path} is already on this drive and will be left alone. Updating it changes only the settings this application is responsible for and keeps everything else in the file.`
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
            onClick={() => write(wanted ?? '', false)}
          >
            Write it now
          </button>
        )}
        {state?.exists && !matches && (
          <>
            <button
              className="button secondary compact"
              disabled={action.busy}
              title="Change only this application's settings and keep the rest of the file"
              onClick={() => write(merged ?? '', true)}
            >
              Update it
            </button>
            <button
              className="button secondary compact danger"
              disabled={action.busy}
              title="Discard the file on the drive and write this application's settings alone"
              onClick={() => write(wanted ?? '', true)}
            >
              Replace it entirely
            </button>
          </>
        )}
      </div>
      {showing && <pre className="drive-config-file">{merged ?? wanted}</pre>}
    </div>
  )
}
