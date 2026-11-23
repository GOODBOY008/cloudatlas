import { useEffect, useLayoutEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, GripVertical, Minus, MoveUpLeft, Sparkles } from 'lucide-react'
import { useCopilotStore } from '../store/copilotStore'
import { useIsDesktop } from './copilot/useMediaQuery'
import { useWindowControls } from './copilot/useWindowControls'
import { WindowControls } from './copilot/WindowControls'
import CopilotChat from './copilot/CopilotChat'
import { NativeDialog } from './shared/NativeDialog'

function readViewport(desktop: boolean) {
  const visible = desktop ? null : window.visualViewport
  return { width: window.innerWidth, height: visible?.height ?? window.innerHeight, top: visible?.offsetTop ?? 0 }
}

function CopilotWindow({ open, desktop }: { open: boolean; desktop: boolean }) {
  const { t } = useTranslation()
  const setOpen = useCopilotStore((state) => state.setOpen)
  const [viewport, setViewport] = useState(() => readViewport(desktop))
  const { rect, grip, expanded, step, feedback } = useWindowControls(viewport, desktop && open)

  useLayoutEffect(() => {
    if (!open) return
    const update = () => setViewport(readViewport(desktop))
    update()
    window.addEventListener('resize', update)
    // Mobile keyboards can shrink and pan the visual viewport independently of the layout viewport.
    const visible = desktop ? null : window.visualViewport
    visible?.addEventListener('resize', update)
    visible?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      visible?.removeEventListener('resize', update)
      visible?.removeEventListener('scroll', update)
    }
  }, [desktop, open])

  const moveLabel = t('copilot.moveHandle')
  const resizeLabel = t('copilot.resize')
  const minimizeLabel = t('copilot.minimize')
  return (
    <NativeDialog id="copilot-window" open={open} modal={!desktop} label={t('copilot.title')}
      className={desktop ? 'copilot-window' : 'items-end'}
      style={desktop ? { ...rect } : { top: viewport.top, height: viewport.height }}
      onClose={() => setOpen(false)}>
      <div className={desktop ? 'copilot-window-body' : 'copilot-sheet'}>
        {desktop && <button type="button" className="copilot-resize-grip" aria-label={resizeLabel} title={resizeLabel} {...grip('resize')}>
          <MoveUpLeft size={12} />
        </button>}
        <CopilotChat
          presentation={open ? (desktop ? 'floating' : 'sheet') : 'hidden'}
          titleSlot={desktop && (
            <button type="button" className="copilot-move-grip" aria-label={moveLabel} title={moveLabel} {...grip('move')}>
              <Sparkles size={17} className="text-accent" />
              <span>{t('copilot.title')}</span>
              <GripVertical size={14} className="text-muted" />
            </button>
          )}
          tools={desktop && expanded && <WindowControls size={rect} step={step} />}
          rightSlot={<button type="button" className="icon-button" aria-label={minimizeLabel} title={minimizeLabel} onClick={() => setOpen(false)}>
            {desktop ? <Minus size={17} /> : <ChevronDown size={19} />}
          </button>}
        />
        {desktop && <div className="sr-only" aria-live="polite" aria-atomic="true">
          <span key={feedback.revision}>{feedback.message}</span>
        </div>}
      </div>
    </NativeDialog>
  )
}

/** One dialog and chat instance per workspace, from first use until leaving the workspace. */
export default function CopilotPanel() {
  const open = useCopilotStore((state) => state.open)
  const setOpen = useCopilotStore((state) => state.setOpen)
  const toggle = useCopilotStore((state) => state.toggle)
  const desktop = useIsDesktop()
  const [started, setStarted] = useState(open)
  useEffect(() => { if (open) setStarted(true) }, [open])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const shortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i'
      const dismiss = open && desktop && event.key === 'Escape'
      if (!shortcut && !dismiss) return
      if (document.querySelector('dialog:modal:not(#copilot-window), [role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      if (shortcut) toggle()
      else setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [desktop, open, setOpen, toggle])

  return open || started ? <CopilotWindow open={open} desktop={desktop} /> : null
}
