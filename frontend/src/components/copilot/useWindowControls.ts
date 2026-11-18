import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import { adjustWindow, fitWindow, type WindowAction, type WindowRect, type WindowSize } from '../../lib/copilotWindow'
import { useCopilotStore } from '../../store/copilotStore'

export const STEP = 16
const arrows: Record<string, [number, number]> = {
  ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0],
  ArrowUp: [0, -STEP], ArrowDown: [0, STEP],
}

interface Gesture {
  rect: WindowRect
  x: number
  y: number
  id: number
  moved: boolean
}

export function useWindowControls(viewport: WindowSize, active: boolean) {
  const { t } = useTranslation()
  const layout = useCopilotStore((state) => state.layout)
  const setLayout = useCopilotStore((state) => state.setLayout)
  const [preview, setPreview] = useState<WindowRect | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [feedback, setFeedback] = useState({ message: '', revision: 0 })
  const gesture = useRef<Gesture | null>(null)
  const suppressClick = useRef(false)
  const rect = fitWindow(preview ?? layout, viewport)

  useEffect(() => {
    if (!active) {
      gesture.current = null
      setPreview(null)
      setExpanded(false)
    }
  }, [active])

  function commit(start: WindowRect, action: WindowAction, dx: number, dy: number) {
    const next = adjustWindow(start, action, dx, dy, viewport)
    if (start.left === next.left && start.top === next.top) return
    setLayout(next)
    const message = action === 'move'
      ? t('copilot.windowMoved')
      : t('copilot.windowSize', { width: next.width, height: next.height })
    setFeedback((previous) => ({ message, revision: previous.revision + 1 }))
  }

  function step(action: WindowAction, dx: number, dy: number) {
    commit(rect, action, dx, dy)
  }

  function grip(action: WindowAction): ButtonHTMLAttributes<HTMLButtonElement> {
    return {
      'aria-expanded': expanded,
      onKeyDown(event) {
        const delta = arrows[event.key]
        if (!delta) return
        event.preventDefault()
        step(action, ...delta)
      },
      onClick(event) {
        if (event.detail === 0 || !suppressClick.current) setExpanded((value) => !value)
        suppressClick.current = false
      },
      onPointerDown(event) {
        if (gesture.current || event.button !== 0 || !event.isPrimary) return
        suppressClick.current = false
        gesture.current = { rect, x: event.clientX, y: event.clientY, id: event.pointerId, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove(event) {
        const start = gesture.current
        if (!start || start.id !== event.pointerId) return
        const dx = event.clientX - start.x
        const dy = event.clientY - start.y
        if (!start.moved && Math.hypot(dx, dy) < 4) return
        start.moved = true
        setPreview(adjustWindow(start.rect, action, dx, dy, viewport))
      },
      onPointerUp(event) {
        const start = gesture.current
        if (!start || start.id !== event.pointerId) return
        if (start.moved) {
          commit(start.rect, action, event.clientX - start.x, event.clientY - start.y)
          suppressClick.current = true
        }
        gesture.current = null
        setPreview(null)
      },
      onLostPointerCapture(event) {
        if (gesture.current?.id !== event.pointerId) return
        gesture.current = null
        setPreview(null)
      },
    }
  }

  return { rect, expanded, grip, step, feedback }
}
