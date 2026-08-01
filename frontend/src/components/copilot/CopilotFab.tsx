import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { useCopilotStore } from '../../store/copilotStore'

/** Mobile-only bottom-right launcher — the user's 右下角 idea (spec §4.1). */
export default function CopilotFab() {
  const { t } = useTranslation()
  const open = useCopilotStore((s) => s.open)
  const setOpen = useCopilotStore((s) => s.setOpen)
  if (open) return null
  return (
    <button
      onClick={() => setOpen(true)}
      aria-label={t('copilot.openCopilot')}
      className="lg:hidden fixed bottom-5 right-5 z-40 w-12 h-12 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg flex items-center justify-center transition-colors"
    >
      <Sparkles size={20} />
    </button>
  )
}
