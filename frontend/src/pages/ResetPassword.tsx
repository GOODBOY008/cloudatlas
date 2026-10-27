import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import AuthShell from '../components/AuthShell'
import { ArrowLeft, ArrowRight } from 'lucide-react'

export default function ResetPassword() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()

  const [token, setToken] = useState(searchParams.get('token') ?? '')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const tok = searchParams.get('token')
    if (tok) setToken(tok)
  }, [searchParams])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setMessage('')
    if (!token.trim()) {
      setError(t('reset.missingToken'))
      return
    }
    setLoading(true)
    try {
      await api.post('/auth/reset-password', { token: token.trim(), password })
      setMessage(t('reset.success'))
      setTimeout(() => navigate('/login'), 1500)
    } catch {
      setError(t('reset.failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell>
      <button className="text-link mb-8" onClick={() => navigate('/login')}>
        <ArrowLeft size={14} />
        {t('design.backToSignIn')}
      </button>
      <div className="mb-8">
        <h1 className="text-[30px] font-semibold tracking-[-1px] text-primary">
          {t('reset.title')}
        </h1>
        <p className="mt-3 text-[13px] text-secondary">{t('reset.subtitle')}</p>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-danger/25 bg-danger/10 p-3 text-xs text-danger"
        >
          {error}
        </div>
      )}
      {message && (
        <div
          role="status"
          className="mb-5 rounded-lg border border-success/25 bg-success/10 p-3 text-xs text-success"
        >
          {message}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="reset-token" className="auth-label">
            {t('reset.token')}
          </label>
          <input
            id="reset-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="auth-input font-mono"
            placeholder={t('reset.tokenPlaceholder')}
          />
        </div>
        <div>
          <label htmlFor="reset-password" className="auth-label">
            {t('reset.newPassword')}
          </label>
          <input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="auth-input"
            placeholder={t('reset.passwordPlaceholder')}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="btn-primary !mt-7 w-full !py-3.5"
        >
          {loading ? t('common.loading') : t('reset.submit')}
          <ArrowRight size={15} />
        </button>
      </form>
    </AuthShell>
  )
}
