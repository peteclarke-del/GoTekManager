import type { ReactNode } from 'react'
import { Archive, RefreshCw, X } from 'lucide-react'
import type { Notice } from '../domain/types'

/**
 * A blocking progress dialog.
 *
 * Reserved for work the user started and must wait for: scanning, downloading,
 * or applying. Background refreshes report inline instead, so the interface
 * never flashes a modal at someone who is still typing.
 */
export function ProgressDialog({
  title,
  detail,
  progress,
}: {
  title: string
  detail: string
  progress?: number
}) {
  return (
    <div
      className="modal-backdrop progress-backdrop"
      role="alertdialog"
      aria-live="assertive"
      aria-label={title}
    >
      <section className="modal progress-dialog" aria-busy="true">
        <RefreshCw className="spinning" />
        <div>
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={progress === undefined ? undefined : { width: `${progress}%` }} />
        </div>
        <small>{progress === undefined ? 'Please wait…' : `${progress}% complete`}</small>
      </section>
    </div>
  )
}

export function Empty({
  title,
  action,
  run,
}: {
  title: string
  action?: string
  run?: () => void
}) {
  return (
    <div className="empty">
      <Archive />
      <b>{title}</b>
      {action && run && (
        <button className="button secondary" onClick={run}>
          {action}
        </button>
      )}
    </div>
  )
}

export function NoticeBar({ notice, dismiss }: { notice: Notice; dismiss: () => void }) {
  return (
    <div className={`notice ${notice.kind}`} role="status" aria-live="polite">
      {notice.text}
      <button aria-label="Dismiss" onClick={dismiss}>
        <X />
      </button>
    </div>
  )
}

/** A short inline status line, used where a modal would be too heavy-handed. */
export function InlineStatus({
  kind,
  children,
}: {
  kind: 'success' | 'error' | 'info'
  children: ReactNode
}) {
  return (
    <div className={`source-status ${kind}`} role="status" aria-live="polite">
      {children}
    </div>
  )
}
