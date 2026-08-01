import type { ReactNode } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} aria-hidden="true" />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <div
          className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
        >
          <div className="flex items-center justify-between mb-5">
            <h2 id="modal-title" className="text-base font-semibold text-white">{title}</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white text-xl leading-none transition-colors"
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
