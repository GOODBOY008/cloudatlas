import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useDialogFocus } from '../../lib/hooks/useDialogFocus'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export function Modal({ title, onClose, children }: ModalProps) {
  const { t } = useTranslation()
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
          className="dialog-panel w-full max-w-md"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className="dialog-heading">
            <h2 id={titleId} className="text-base font-semibold text-primary">{title}</h2>
            <button
              onClick={onClose}
              className="icon-button"
              aria-label={t('common.close')}
            >
              <X size={18} />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
        </div>
      </div>
    </>
  )
}
