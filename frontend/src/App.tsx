import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from './store/authStore'
import { productRoutes } from './app/routeCatalog'
import NotFound from './pages/NotFound'
import ErrorBoundary from './components/ErrorBoundary'
import { useThemeStore } from './store/themeStore'
import Login from './pages/Login'
import { auth } from './lib/auth'
import { SSO_COMPLETE_PATH } from './lib/loginRedirect'

const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'))
const SsoSession = lazy(() => import('./pages/SsoSession'))
const Layout = lazy(() => import('./components/Layout'))

function RequireAuth({ children }: { children: React.ReactNode }) {
  const authenticated = useAuthStore((state) => !!state.accessToken)
  const location = useLocation()
  return authenticated ? <>{children}</> : <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />
}

function RedirectIfAuth({ children }: { children: React.ReactNode }) {
  return useAuthStore((state) => !!state.accessToken) ? <Navigate to="/dashboard" replace /> : <>{children}</>
}

function PageFallback() {
  const { t } = useTranslation()
  return <div className="space-y-5 p-6" role="status" aria-label={t('common.loading')}><div className="skeleton h-8 w-48" /><div className="grid grid-cols-2 gap-4"><div className="skeleton h-32" /><div className="skeleton h-32" /></div><div className="skeleton h-64" /></div>
}

export default function App() {
  const theme = useThemeStore((state) => state.theme)
  const { pathname } = useLocation()
  const [restoringSso, setRestoringSso] = useState(() => (
    pathname !== SSO_COMPLETE_PATH && auth.hasSsoSession() && !auth.isAuthenticated()
  ))
  const finishRestore = useCallback(() => setRestoringSso(false), [])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#14161b' : '#f8f9fb')
  }, [theme])

  return (
    <Suspense fallback={<PageFallback />}>
      {restoringSso && pathname !== SSO_COMPLETE_PATH && pathname !== '/reset-password' ? (
        <SsoSession onRestored={finishRestore} />
      ) : (
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectIfAuth>
                <Login />
              </RedirectIfAuth>
            }
          />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path={SSO_COMPLETE_PATH} element={<SsoSession />} />
          <Route
            element={
              <ErrorBoundary>
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              </ErrorBoundary>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />
            {productRoutes.map(({ path, component: Page }) => (
              <Route key={path} path={path} element={<Page />} />
            ))}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      )}
    </Suspense>
  )
}
