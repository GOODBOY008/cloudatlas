import { Button } from '@cloudflare/kumo/components/button'
import { useTranslation } from 'react-i18next'
import { changeAppLanguage } from '../i18n'

/** Language switcher for pre-auth screens (login / reset password). */
export default function LanguageToggle() {
  const { t, i18n } = useTranslation()
  const next = i18n.language === 'zh' ? 'en' : 'zh'
  return (
    <Button variant="ghost" shape="square"
      onClick={() => { void changeAppLanguage(next) }}
      aria-label={t('header.switchLanguage')}
    >
      {i18n.language === 'zh' ? 'EN' : t('common.languageName')}
    </Button>
  )
}
