import { KumoPortalProvider } from '@cloudflare/kumo/utils'
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'

interface NativeDialogProps {
  children: ReactNode
  id?: string
  className?: string
  style?: CSSProperties
  open?: boolean
  modal?: boolean
  label?: string
  labelledBy?: string
  onClose: () => void
}

/** By default, mounting opens a modal. Controlled callers may retain their contents while closed. */
export function NativeDialog({ children, id, className, style, open = true, modal = true, label, labelledBy, onClose }: NativeDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const pressedBackdrop = useRef(false)

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog || !open) return
    if (modal) dialog.showModal()
    else dialog.show()
    return () => {
      pressedBackdrop.current = false
      if (dialog.open) dialog.close()
    }
  }, [open, modal])

  return (
    <dialog
      ref={ref}
      id={id}
      style={style}
      className={`native-dialog ${className ?? ''}`}
      aria-label={label}
      aria-labelledby={labelledBy}
      onClose={(event) => {
        if (!event.currentTarget.open) onClose()
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = modal && event.isPrimary && event.button === 0 && event.target === event.currentTarget
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
      <KumoPortalProvider container={ref}>{children}</KumoPortalProvider>
    </dialog>
  )
}
