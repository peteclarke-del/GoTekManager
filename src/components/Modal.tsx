import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * A dialog with a backdrop, a close control, and Escape-to-close.
 *
 * Every dialog in the application used to repeat this markup, and none of them
 * closed on Escape.
 */
export function Modal({
  title,
  children,
  onClose,
  className = '',
  closeLabel = 'Close',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
  closeLabel?: string
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className={`modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button className="modal-close" aria-label={closeLabel} onClick={onClose}>
          <X />
        </button>
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  )
}
