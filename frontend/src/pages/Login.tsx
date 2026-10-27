import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { auth } from '../lib/auth'
import AuthShell from '../components/AuthShell'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
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
  const [showPassword, setShowPassword] = useState(false)
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
    api
      .get<{ data: { enabled: boolean } }>('/auth/oidc/config')
      .then((res) => setSsoEnabled(res.data.data.enabled))
      .catch(() => {
        /* SSO optional */
      })
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data: res } = await api.post<ApiResponse<AuthResponse>>(
        '/auth/login',
        {
          email,
          password,
          totp_code: totpCode || undefined,
        },
      )
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
    <AuthShell>
      <div className="mb-9">
        <h1 className="text-[30px] font-semibold tracking-[-1px] text-primary">
          {t('design.welcomeBack')}
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-secondary">
          {t('design.signInDescription')}
        </p>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-danger/25 bg-danger/10 p-3 text-xs text-danger"
        >
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="login-email" className="auth-label">
            {t('login.email')}
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="auth-input"
            placeholder={t('login.emailPlaceholder')}
          />
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="login-password" className="auth-label">
              {t('login.password')}
            </label>
            <button
              type="button"
              onClick={forgotPassword}
              className="mb-2 text-[11px] font-medium text-accent hover:underline"
            >
              {t('login.forgotPassword')}
            </button>
          </div>
          <div className="relative">
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="auth-input pr-12"
              placeholder={t('login.passwordPlaceholder')}
            />
            <button
              type="button"
              className="icon-button absolute right-1 top-1"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={t(
                showPassword ? 'design.hidePassword' : 'design.showPassword',
              )}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        {totpCode !== '' ||
        error.includes('Two-factor') ||
        error.includes('two-factor') ? (
          <div>
            <label htmlFor="login-totp" className="auth-label">
              {t('login.totpCode')}
            </label>
            <input
              id="login-totp"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="auth-input"
              placeholder="000000"
            />
          </div>
        ) : null}
        {forgotSent && (
          <div
            role="status"
            className="rounded-lg border border-success/25 bg-success/10 p-3 text-xs text-success"
          >
            {t('login.forgotSent')}
          </div>
        )}
        <button
          type="submit"
          disabled={loading}
          className="btn-primary !mt-7 w-full !py-3.5"
        >
          {loading ? t('login.signingIn') : t('login.signIn')}
          <ArrowRight size={15} />
        </button>
      </form>
      {ssoEnabled && (
        <>
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-edge" />
            <span className="text-xs text-muted">{t('login.or')}</span>
            <div className="h-px flex-1 bg-edge" />
          </div>
          <button
            type="button"
            onClick={loginWithSso}
            className="btn-secondary w-full"
          >
            {t('login.sso')}
          </button>
        </>
      )}
      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => navigate('/reset-password')}
          className="text-xs text-secondary hover:text-accent"
        >
          {t('login.resetWithToken')}
        </button>
      </div>
    </AuthShell>
  )
}
