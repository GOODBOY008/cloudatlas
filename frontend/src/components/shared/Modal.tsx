import { useId, type ReactNode } from 'react'
import { useDialogFocus } from '../../lib/hooks/useDialogFocus'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export function Modal({ title, onClose, children }: ModalProps) {
  const titleId = useId()
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} aria-hidden="true" />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="bg-surface border border-edge rounded-2xl shadow-popover w-full max-w-md max-h-[90dvh] overflow-y-auto p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className="flex items-center justify-between mb-5">
            <h2 id={titleId} className="text-base font-semibold text-primary">{title}</h2>
            <button
              onClick={onClose}
              className="text-secondary hover:text-primary text-xl leading-none transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          {children}
        </div>
      </div>
    </>
  )
}
