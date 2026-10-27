import { useLayoutEffect, useRef, useState } from 'react'

/** Focus containment for modal dialogs, preserving autofocus and the launcher. */
export function useDialogFocus<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
) {
  const ref = useRef<T>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // A newly mounted Modal must capture the launcher before child autoFocus runs.
  const [initialReturnFocus] = useState(
    () => document.activeElement as HTMLElement | null,
  )
  const returnFocusRef = useRef(initialReturnFocus)
  const initialDialogFocusRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      initialDialogFocusRef.current = null
      // Persistent dialogs (search/navigation) may reopen from another control.
      const rememberFocus = () => {
        returnFocusRef.current = document.activeElement as HTMLElement | null
      }
      rememberFocus()
      document.addEventListener('focusin', rememberFocus)
      return () => document.removeEventListener('focusin', rememberFocus)
    }
    const previous = returnFocusRef.current
    const panel = ref.current
    if (!panel) return
    const focusable = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0)
    if (panel.contains(document.activeElement)) {
      initialDialogFocusRef.current = document.activeElement as HTMLElement
    } else {
      // Keep the chosen initial target across StrictMode's setup/cleanup replay.
      const initial = initialDialogFocusRef.current
      const target =
        initial && panel.contains(initial) ? initial : focusable()[0] ?? panel
      initialDialogFocusRef.current = target
      target.focus()
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
      if (event.key === 'Tab') {
        const items = focusable()
        const first = items[0]
        const last = items[items.length - 1]
        if (!first) {
          event.preventDefault()
          return
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === panel)
        ) {
          event.preventDefault()
          last.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === panel)
        ) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    panel.addEventListener('keydown', onKey)
    return () => {
      panel.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  return ref
}
