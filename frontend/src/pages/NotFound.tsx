import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Compass } from 'lucide-react'

export default function NotFound() {
  const { t } = useTranslation()
  return <div className="empty-state panel py-16">
    <Compass className="empty-state-icon" aria-hidden="true" />
    <h1 className="page-title">{t('design.pageNotFound')}</h1>
    <p className="page-description">{t('design.pageNotFoundHint')}</p>
    <Link to="/dashboard" className="btn-primary mt-5">{t('nav.dashboard')}</Link>
  </div>
}
