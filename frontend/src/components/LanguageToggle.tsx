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
      className="icon-button text-xs font-medium"
    >
      {i18n.language === 'zh' ? 'EN' : t('common.languageName')}
    </button>
  )
}
