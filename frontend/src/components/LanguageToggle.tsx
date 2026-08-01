import { useTranslation } from 'react-i18next'
import { setStoredLanguage } from '../i18n'

/** Language switcher for pre-auth screens (login / reset password). */
export default function LanguageToggle() {
  const { t, i18n } = useTranslation()
  const next = i18n.language === 'zh' ? 'en' : 'zh'
  return (
    <button
      onClick={() => {
        i18n.changeLanguage(next)
        setStoredLanguage(next)
      }}
      aria-label={t('header.switchLanguage')}
      className="fixed top-4 right-4 px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-200 text-gray-700 border border-gray-300 hover:bg-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-700 transition-colors"
    >
      {i18n.language === 'zh' ? 'EN' : t('common.languageName')}
    </button>
  )
}
