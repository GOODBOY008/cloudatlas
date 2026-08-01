import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import LanguageToggle from '../components/LanguageToggle'

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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <LanguageToggle />
      <div className="w-full max-w-sm bg-gray-900 rounded-2xl shadow-xl p-8 border border-gray-800">
        <div className="mb-8 text-center">
          <div className="text-4xl mb-2">☁</div>
          <h1 className="text-2xl font-bold text-white">{t('reset.title')}</h1>
          <p className="text-gray-400 text-sm mt-1">{t('reset.subtitle')}</p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-4 p-3 rounded-lg bg-green-900/40 border border-green-700 text-green-300 text-sm">
            {message}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">{t('reset.token')}</label>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder={t('reset.tokenPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">{t('reset.newPassword')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder={t('reset.passwordPlaceholder')}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold rounded-lg transition-colors"
          >
            {loading ? t('common.loading') : t('reset.submit')}
          </button>
        </form>
      </div>
    </div>
  )
}
