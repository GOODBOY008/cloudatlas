import { Button } from '@cloudflare/kumo/components/button'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus, Plus, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_LAYOUT, type WindowAction, type WindowSize } from '../../lib/copilotWindow'
import { useCopilotStore } from '../../store/copilotStore'
import { STEP } from './useWindowControls'

const directions = [
  { label: 'copilot.moveLeft', Icon: ArrowLeft, dx: -STEP, dy: 0 },
  { label: 'copilot.moveUp', Icon: ArrowUp, dx: 0, dy: -STEP },
  { label: 'copilot.moveDown', Icon: ArrowDown, dx: 0, dy: STEP },
  { label: 'copilot.moveRight', Icon: ArrowRight, dx: STEP, dy: 0 },
]

const dimensions = [
  { axis: 'width', label: 'copilot.width', less: 'copilot.narrower', more: 'copilot.wider', dx: STEP, dy: 0 },
  { axis: 'height', label: 'copilot.height', less: 'copilot.shorter', more: 'copilot.taller', dx: 0, dy: STEP },
] as const

export function WindowControls({ size, step }: {
  size: WindowSize
  step: (action: WindowAction, dx: number, dy: number) => void
}) {
  const { t } = useTranslation()
  const setLayout = useCopilotStore((state) => state.setLayout)
  return (
    <div className="copilot-controls" role="group" aria-label={t('copilot.windowControls')}>
      <div className="flex items-center gap-1">
        {directions.map(({ label, Icon, dx, dy }) => (
          <Button variant="ghost" shape="square" type="button" key={label} aria-label={t(label)} title={t(label)} onClick={() => step('move', dx, dy)}>
            <Icon size={15} />
          </Button>
        ))}
        <button type="button" className="text-link ml-auto inline-flex items-center gap-1" onClick={() => setLayout(DEFAULT_LAYOUT)}>
          <RotateCcw size={13} /> {t('copilot.resetLayout')}
        </button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {dimensions.map(({ axis, label, less, more, dx, dy }) => (
          <div key={axis} className="flex items-center gap-1">
            <span>{t(label)}</span>
            <Button variant="ghost" shape="square" type="button" aria-label={t(less)} title={t(less)} onClick={() => step('resize', dx, dy)}>
              <Minus size={14} />
            </Button>
            <span className="tabular-nums">{size[axis]}</span>
            <Button variant="ghost" shape="square" type="button" aria-label={t(more)} title={t(more)} onClick={() => step('resize', -dx, -dy)}>
              <Plus size={14} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
