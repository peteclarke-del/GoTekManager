import { useEffect, useState } from 'react'
import { Download, ExternalLink, HardDrive, RefreshCw, RotateCcw } from 'lucide-react'
import { APPLICATION_NAME, controlsFor, downloadText } from '../domain/appUpdate'
import type { AppAbout } from '../domain/types'
import { percentageOf } from '../hooks/progress'
import type { AppUpdater } from '../hooks/useAppUpdate'
import { appAbout, openExternal } from '../native/commands'
import { Modal } from './Modal'

/**
 * The About box: which application and version this is, and updating it.
 */
export function AboutDialog({ updater, close }: { updater: AppUpdater; close: () => void }) {
  const [about, setAbout] = useState<AppAbout | null>(null)

  useEffect(() => {
    appAbout().then(setAbout, () => setAbout(null))
  }, [])

  return (
    <Modal title={`About ${APPLICATION_NAME}`} onClose={close} className="about-modal">
      <div className="about-identity">
        <span className="brand-mark">
          <HardDrive />
        </span>
        <div>
          <b>{about?.name ?? APPLICATION_NAME}</b>
          {about && <span>Version {about.version}</span>}
        </div>
      </div>
      <p className="mode-note">
        Catalogues retro-software disk images and prepares media for a GoTek floppy emulator.
        Released under the MIT licence.
      </p>
      {about?.homepage && (
        <button className="link-button" onClick={() => void openExternal(about.homepage)}>
          Project page
        </button>
      )}
      <AppUpdateControls updater={updater} />
    </Modal>
  )
}

/**
 * The Check for Application Updates button, and everything that follows it:
 * the answer, the download with its progress, the install, and the restart.
 */
export function AppUpdateControls({ updater }: { updater: AppUpdater }) {
  const { state, progress } = updater
  const controls = controlsFor(state)
  const { primary, releasePage } = controls
  const run = {
    check: () => void updater.check(),
    confirm: updater.confirm,
    page: updater.openPage,
    restart: updater.restart,
    quit: updater.quit,
  }
  const total = progress?.total ?? 0
  const percent = progress && total ? percentageOf(progress.done, total) : undefined

  return (
    <section className="app-update" aria-live="polite">
      {primary && (
        <button
          className={`button ${primary.suggested ? '' : 'secondary'} compact`.trim()}
          disabled={state.phase === 'checking'}
          onClick={run[primary.action]}
        >
          {primary.action === 'restart' ? (
            <RotateCcw />
          ) : primary.action === 'confirm' ? (
            <Download />
          ) : primary.action === 'page' ? (
            <ExternalLink />
          ) : (
            <RefreshCw className={state.phase === 'checking' ? 'spinning' : ''} />
          )}
          {primary.label}
        </button>
      )}
      {state.message && <p className="app-update-message">{state.message}</p>}
      {controls.progress && (
        <div className="app-update-progress">
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Downloading the update"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
          </div>
          <small>{progress ? downloadText(progress.done, progress.total) : 'Starting'}</small>
          <button className="button secondary compact" onClick={updater.cancel}>
            Cancel
          </button>
        </div>
      )}
      {controls.spinner && <RefreshCw className="spinning app-update-spinner" />}
      {state.phase === 'confirming' && (
        <div className="app-update-confirm">
          <button className="button secondary compact" onClick={updater.back}>
            Cancel
          </button>
          <button className="button compact" onClick={() => void updater.install()}>
            <Download />
            {state.update?.method === 'diskImage'
              ? 'Download and Open'
              : 'Download and Install'}
          </button>
        </div>
      )}
      {releasePage && (
        <button className="link-button" onClick={updater.openPage}>
          Release Page
        </button>
      )}
      {state.update?.notes && (state.phase === 'available' || state.phase === 'confirming') && (
        <pre className="drive-config-file">{state.update.notes}</pre>
      )}
    </section>
  )
}
