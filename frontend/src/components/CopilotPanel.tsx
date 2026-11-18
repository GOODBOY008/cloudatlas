import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useCopilotStore } from '../store/copilotStore'
import { useIsDesktop } from './copilot/useMediaQuery'
import CopilotChat from './copilot/CopilotChat'
import { NativeDialog } from './shared/NativeDialog'

/** Drag + keyboard resize handle on the panel's left edge (spec §4.1). */
function ResizeHandle() {
  const { t } = useTranslation()
  const width = useCopilotStore((s) => s.width)
  const setWidth = useCopilotStore((s) => s.setWidth)
  const dragging = useRef(false)

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragging.current) return
      // Panel docks right: pointer x from the right edge = panel width.
      setWidth(window.innerWidth - e.clientX)
    }
    function onUp() {
      dragging.current = false
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [setWidth])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('copilot.resize')}
      title={t('copilot.resize')}
      tabIndex={0}
      onPointerDown={() => {
        dragging.current = true
        document.body.style.userSelect = 'none'
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setWidth(width + 16) // wider
        if (e.key === 'ArrowRight') setWidth(width - 16) // narrower
      }}
      className="absolute left-0 inset-y-0 w-1 z-10 cursor-col-resize hover:bg-accent-hover/40 active:bg-accent/60"
    />
  )
}

function closeButton(onClose: () => void, label: string) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      className="icon-button"
    >
      <X size={18} />
    </button>
  )
}

/**
 * Copilot shells (spec §4.1): a non-modal docked aside on desktop (≥1024 px)
 * and a modal bottom sheet below that. Conversation UI lives in CopilotChat.
 */
export default function CopilotPanel() {
  const { t } = useTranslation()
  const open = useCopilotStore((s) => s.open)
  const setOpen = useCopilotStore((s) => s.setOpen)
  const toggle = useCopilotStore((s) => s.toggle)
  const width = useCopilotStore((s) => s.width)
  const isDesktop = useIsDesktop()
  // Native dialog dismissal handles Escape on mobile.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        toggle()
      }
      if (isDesktop && e.key === 'Escape' && !e.defaultPrevented) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDesktop, toggle, setOpen])

  useLayoutEffect(() => {
    if (!open || !isDesktop) return
    const launcher = document.activeElement
    return () => {
      if (launcher instanceof HTMLElement) launcher.focus()
    }
  }, [isDesktop, open])

  if (!open) return null

  const close = () => setOpen(false)

  if (isDesktop) {
    return (
      <aside
        role="complementary"
        aria-label={t('copilot.title')}
        style={{ width }}
        className="relative hidden lg:flex flex-col flex-shrink-0 h-full bg-surface border-l border-edge transition-colors"
      >
        <ResizeHandle />
        <CopilotChat rightSlot={closeButton(close, t('common.cancel'))} />
      </aside>
    )
  }

  return (
    <NativeDialog className="items-end" label={t('copilot.title')} onClose={close}>
      <div className="h-[75dvh] w-full bg-surface rounded-t-2xl border-t border-edge flex flex-col shadow-popover">
        <CopilotChat rightSlot={closeButton(close, t('common.close'))} />
      </div>
    </NativeDialog>
  )
}
