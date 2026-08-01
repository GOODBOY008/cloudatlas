import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { auth } from '../lib/auth'
import LanguageToggle from '../components/LanguageToggle'
import type { AuthResponse, ApiResponse } from '../types'

export default function Login() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [ssoEnabled, setSsoEnabled] = useState(false)
  const [forgotSent, setForgotSent] = useState(false)

  // OIDC callback: /login?token=…&refresh=…
  useEffect(() => {
    const token = searchParams.get('token')
    const refresh = searchParams.get('refresh')
    if (token && refresh) {
      auth.setTokens(token, refresh)
      navigate('/dashboard', { replace: true })
    }
  }, [searchParams, navigate])

  // SSO availability
  useEffect(() => {
    api.get<{ data: { enabled: boolean } }>('/auth/oidc/config')
      .then((res) => setSsoEnabled(res.data.data.enabled))
      .catch(() => {/* SSO optional */})
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data: res } = await api.post<ApiResponse<AuthResponse>>('/auth/login', {
        email,
        password,
        totp_code: totpCode || undefined,
      })
      auth.setTokens(res.data.access_token, res.data.refresh_token)
      navigate('/dashboard')
    } catch {
      setError(t('login.invalidCredentials'))
    } finally {
      setLoading(false)
    }
  }

  async function forgotPassword() {
    if (!email.trim()) return
    try {
      await api.post('/auth/forgot-password', { email: email.trim() })
      setForgotSent(true)
    } catch {
      setError(t('login.error'))
    }
  }

  function loginWithSso() {
    window.location.href = '/api/v1/auth/oidc/start'
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <LanguageToggle />
      <div className="w-full max-w-sm bg-gray-900 rounded-2xl shadow-xl p-8 border border-gray-800">
        <div className="mb-8 text-center">
          <div className="text-4xl mb-2">☁</div>
          <h1 className="text-2xl font-bold text-white">{t('login.title')}</h1>
          <p className="text-gray-400 text-sm mt-1">{t('login.subtitle')}</p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">{t('login.email')}</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder={t('login.emailPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">{t('login.password')}</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder={t('login.passwordPlaceholder')}
            />
          </div>
          {totpCode !== '' || error.includes('Two-factor') || error.includes('two-factor') ? (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                {t('login.totpCode')}
              </label>
              <input
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode="numeric"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="000000"
              />
            </div>
          ) : null}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold rounded-lg transition-colors"
          >
            {loading ? t('login.signingIn') : t('login.signIn')}
          </button>
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={forgotPassword}
              className="text-gray-500 hover:text-gray-300"
            >
              {t('login.forgotPassword')}
            </button>
            <button
              type="button"
              onClick={() => navigate('/reset-password')}
              className="text-gray-500 hover:text-gray-300"
            >
              {t('login.resetWithToken')}
            </button>
          </div>
          {forgotSent && (
            <div className="p-3 rounded-lg bg-green-900/40 border border-green-700 text-green-400 text-sm">
              {t('login.forgotSent')}
            </div>
          )}
          {ssoEnabled && (
            <div className="relative my-2">
              <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-gray-800" /></div>
              <div className="relative flex justify-center"><span className="bg-gray-900 px-3 text-xs text-gray-500">{t('login.or')}</span></div>
            </div>
          )}
        </form>
        {ssoEnabled && (
          <button
            type="button"
            onClick={loginWithSso}
            className="mt-4 w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-white font-semibold rounded-lg transition-colors"
          >
            {t('login.sso')}
          </button>
        )}
      </div>
    </div>
  )
}
