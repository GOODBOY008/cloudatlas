import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useCopilotStore } from '../store/copilotStore'
import { useIsDesktop } from './copilot/useMediaQuery'
import CopilotChat from './copilot/CopilotChat'

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
      className="absolute left-0 inset-y-0 w-1 z-10 cursor-col-resize hover:bg-indigo-500/40 active:bg-indigo-500/60"
    />
  )
}

function closeButton(onClose: () => void, label: string) {
  return (
    <button
      onClick={onClose}
      aria-label={label}
      className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
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
  const lastFocused = useRef<HTMLElement | null>(null)

  // Cmd/Ctrl+I toggles (GlobalSearch owns Cmd-K). Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        toggle()
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, setOpen])

  // Focus management: restore focus to the launcher on close.
  useEffect(() => {
    if (open) {
      lastFocused.current = document.activeElement as HTMLElement | null
    } else if (lastFocused.current) {
      lastFocused.current.focus?.()
      lastFocused.current = null
    }
  }, [open])

  if (!open) return null

  const close = () => setOpen(false)

  if (isDesktop) {
    return (
      <aside
        role="complementary"
        aria-label={t('copilot.title')}
        style={{ width }}
        className="relative hidden lg:flex flex-col flex-shrink-0 h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 transition-colors"
      >
        <ResizeHandle />
        <CopilotChat rightSlot={closeButton(close, t('common.cancel'))} />
      </aside>
    )
  }

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t('copilot.title')}>
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="absolute inset-x-0 bottom-0 h-[75dvh] bg-white dark:bg-gray-900 rounded-t-2xl border-t border-gray-200 dark:border-gray-800 flex flex-col shadow-2xl">
        <CopilotChat rightSlot={closeButton(close, t('common.cancel'))} />
      </div>
    </div>
  )
}
