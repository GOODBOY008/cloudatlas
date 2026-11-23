import { useTranslation } from 'react-i18next'
import { ChevronDown, Sparkles } from 'lucide-react'
import { useCopilotStore } from '../../store/copilotStore'

export default function CopilotFab() {
  const { t } = useTranslation()
  const open = useCopilotStore((s) => s.open)
  const toggle = useCopilotStore((s) => s.toggle)
  const label = t(open ? 'copilot.minimize' : 'copilot.openCopilot')
  return (
    <button
      type="button"
      onClick={(event) => {
        // Safari does not focus buttons on pointer activation.
        event.currentTarget.focus()
        toggle()
      }}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-controls={open ? 'copilot-window' : undefined}
      aria-expanded={open}
      className="copilot-launcher"
    >
      {open ? <ChevronDown size={22} /> : <Sparkles size={21} />}
    </button>
  )
}
