export interface WindowSize {
  width: number
  height: number
}

export interface WindowRect extends WindowSize {
  left: number
  top: number
}

export type CopilotLayout = WindowSize & Partial<Pick<WindowRect, 'left' | 'top'>>
export type WindowAction = 'move' | 'resize'

export const DEFAULT_LAYOUT: CopilotLayout = { width: 400, height: 560 }
const MIN_WIDTH = 320
const MAX_WIDTH = 560
const MIN_HEIGHT = 320
const EDGE = 12
const ABOVE_LAUNCHER = 80

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The original cloudatlas-copilot record contained only width. */
export function readCopilotLayout(saved: unknown): CopilotLayout {
  if (!saved || typeof saved !== 'object') return DEFAULT_LAYOUT
  const { width, height, left, top } = saved as Partial<WindowRect>
  return {
    width: finite(width) ? clamp(width, MIN_WIDTH, MAX_WIDTH) : DEFAULT_LAYOUT.width,
    height: finite(height) ? Math.max(MIN_HEIGHT, height) : DEFAULT_LAYOUT.height,
    ...(finite(left) && finite(top) ? { left, top } : {}),
  }
}

/** Fit the saved preference to this screen without overwriting it on viewport changes. */
export function fitWindow(layout: CopilotLayout, viewport: WindowSize): WindowRect {
  const positioned = layout.left !== undefined && layout.top !== undefined
  const maxWidth = Math.max(1, viewport.width - 2 * EDGE)
  const maxHeight = Math.max(1, viewport.height - EDGE - (positioned ? EDGE : ABOVE_LAUNCHER))
  const width = clamp(layout.width, MIN_WIDTH, Math.min(MAX_WIDTH, maxWidth))
  const height = clamp(layout.height, MIN_HEIGHT, maxHeight)
  return {
    width, height,
    left: clamp(layout.left ?? viewport.width - width - 20, EDGE, viewport.width - width - EDGE),
    top: clamp(layout.top ?? viewport.height - height - ABOVE_LAUNCHER, EDGE, viewport.height - height - EDGE),
  }
}

export function adjustWindow(rect: WindowRect, action: WindowAction, dx: number, dy: number, viewport: WindowSize): WindowRect {
  if (action === 'move') {
    return fitWindow({ ...rect, left: rect.left + dx, top: rect.top + dy }, viewport)
  }
  // The upper-left grip moves while the opposite corner stays in place.
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height
  const width = clamp(rect.width - dx, MIN_WIDTH, Math.min(MAX_WIDTH, right - EDGE))
  const height = clamp(rect.height - dy, MIN_HEIGHT, bottom - EDGE)
  return { width, height, left: right - width, top: bottom - height }
}
