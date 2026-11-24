import { Button } from '@cloudflare/kumo/components/button'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import AuthShell from '../components/AuthShell'
import { auth } from '../lib/auth'
import { LOGIN_RETURN_PATH_KEY, loginRedirect } from '../lib/loginRedirect'

/** Complete the browser handoff, or restore an existing session after a reload. */
export default function SsoSession({ onRestored }: { onRestored?: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (failed) return
    let active = true
    const request = onRestored ? auth.restoreSsoSession() : auth.completeSsoSignIn()
    void request.then((authenticated) => {
      if (!active) return
      if (onRestored) {
        onRestored()
      } else if (authenticated) {
        const destination = loginRedirect(sessionStorage.getItem(LOGIN_RETURN_PATH_KEY))
        sessionStorage.removeItem(LOGIN_RETURN_PATH_KEY)
        navigate(destination, { replace: true })
      } else {
        setFailed(true)
      }
    }).catch(() => {
      if (active) setFailed(true)
    })
    return () => { active = false }
  }, [failed, navigate, onRestored])

  return (
    <AuthShell>
      <h1 className="page-title">{t('login.sso')}</h1>
      {failed ? (
        <div className="mt-4 space-y-4">
          <p role="alert" className="text-sm text-danger">{t('login.ssoError')}</p>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="button" onClick={() => setFailed(false)}>
              {t('dashboard.retry')}
            </Button>
            {onRestored ? (
              <button type="button" className="text-link" onClick={() => {
                auth.clearTokens()
                onRestored()
              }}>
                {t('login.signIn')}
              </button>
            ) : (
              <Link
                to="/login"
                replace
                state={{ from: loginRedirect(sessionStorage.getItem(LOGIN_RETURN_PATH_KEY)) }}
                className="text-link"
              >
                {t('login.signIn')}
              </Link>
            )}
          </div>
        </div>
      ) : (
        <p role="status" className="mt-4 text-sm text-muted">{t('login.ssoLoading')}</p>
      )}
    </AuthShell>
  )
}
