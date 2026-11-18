import { useLayoutEffect, useRef, type ReactNode } from 'react'

interface NativeDialogProps {
  children: ReactNode
  className?: string
  label?: string
  labelledBy?: string
  onClose: () => void
}

/** Mount only while open, so the browser can restore focus before removal. */
export function NativeDialog({ children, className, label, labelledBy, onClose }: NativeDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const pressedBackdrop = useRef(false)

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={`native-dialog ${className ?? ''}`}
      aria-label={label}
      aria-labelledby={labelledBy}
      onClose={(event) => {
        if (!event.currentTarget.open) onClose()
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.isPrimary && event.button === 0 && event.target === event.currentTarget
      }}
      onPointerUp={(event) => {
        if (pressedBackdrop.current && document.elementFromPoint(event.clientX, event.clientY) === event.currentTarget) {
          event.currentTarget.close()
        }
        pressedBackdrop.current = false
      }}
      onPointerCancel={() => {
        pressedBackdrop.current = false
      }}
    >
      {children}
    </dialog>
  )
}
