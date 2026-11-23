import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { CircleHelp, ChevronDown, ChevronRight, Check, Search, Sun, Moon, Menu, X, LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import CopilotPanel from './CopilotPanel'
import CopilotFab from './copilot/CopilotFab'
import NotificationBell from './NotificationBell'
import BackgroundJobsIndicator from './BackgroundJobsIndicator'
import GlobalSearch from './GlobalSearch'
import { setOrgCurrency, useOrgCurrency } from '../lib/format'
import { auth } from '../lib/auth'
import api from '../lib/api'
import { changeAppLanguage, WORKSPACE_NAMESPACE } from '../i18n'
import { useOrgStore } from '../store/orgStore'
import { useThemeStore } from '../store/themeStore'
import Brand from './Brand'
import { helpForPath } from '../lib/help'
import { useDialogFocus } from '../lib/hooks/useDialogFocus'
import { navigationSections as navSections, routeForPath } from '../app/routeCatalog'
import ErrorBoundary from './ErrorBoundary'
import type { Organization } from '../types'

function NavSection({
  section,
  onNavigate,
}: {
  section: (typeof navSections)[number]
  onNavigate: () => void
}) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const active = section.items.some(
    (item) => pathname === item.path || pathname.startsWith(`${item.path}/`),
  )
  const [expanded, setExpanded] = useState(
    active ||
      section.key === 'nav.section.overview' ||
      section.key === 'nav.section.costManagement',
  )
  useEffect(() => {
    if (active) setExpanded(true)
  }, [active])
  return (
    <div className="nav-section">
      <button
        type="button"
        className="nav-heading"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {t(section.key)}
        <ChevronDown
          size={12}
          className={`transition-transform ${expanded ? '' : '-rotate-90'}`}
        />
      </button>
      {expanded && (
        <div className="nav-items">
          {section.items.map(({ path, labelKey, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              onClick={onNavigate}
              className={({ isActive }) =>
                `nav-link ${isActive ? 'active' : ''}`
              }
            >
              <Icon size={16} />
              <span className="truncate">{t(labelKey)}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Layout() {
  useOrgCurrency()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { t, i18n } = useTranslation(['translation', WORKSPACE_NAMESPACE])
  if (!i18n.languages.some(language => i18n.hasResourceBundle(language, WORKSPACE_NAMESPACE))) {
    throw new Error('Workspace translations could not be loaded')
  }
  const { organizations, currentOrg, setOrganizations, setCurrentOrg } =
    useOrgStore()
  const [orgMenuOpen, setOrgMenuOpen] = useState(false)
  const { theme, toggleTheme } = useThemeStore()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [logoutFailed, setLogoutFailed] = useState(false)
  const orgMenuRef = useRef<HTMLDivElement>(null)
  const mobileNavRef = useDialogFocus<HTMLElement>(mobileNavOpen, () =>
    setMobileNavOpen(false),
  )
  const mainRef = useRef<HTMLElement>(null)
  const currentItem = routeForPath(pathname)
  const currentSection = navSections.find((section) => section.key === currentItem?.section)

  useEffect(() => {
    setMobileNavOpen(false)
    setOrgMenuOpen(false)
    mainRef.current?.scrollTo(0, 0)
  }, [pathname])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)')
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileNavOpen(false)
    }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  useEffect(() => {
    function dismiss(event: MouseEvent) {
      if (!orgMenuRef.current?.contains(event.target as Node))
        setOrgMenuOpen(false)
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOrgMenuOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [])

  function switchLanguage() {
    const next = i18n.language === 'zh' ? 'en' : 'zh'
    void changeAppLanguage(next)
  }

  useEffect(() => {
    let active = true
    api
      .get<{ data: Organization[] }>('/organizations')
      .then((res) => {
        if (!active) return
        const orgs = res.data.data ?? []
        setOrganizations(orgs)
      })
      .catch(() => {
        /* Some pages can be used without an organization. */
      })
    return () => { active = false }
  }, [setOrganizations])

  const workspaceId = currentOrg?.id
  const workspaceCurrency = currentOrg?.settings?.currency
  useLayoutEffect(() => {
    setOrgCurrency(workspaceCurrency ?? 'USD')
    if (workspaceCurrency) return
    let active = true
    const id = workspaceId
    if (!id) return
    api.get<{ data: { settings?: { currency?: string } } }>(`/organizations/${id}`)
      .then((res) => {
        if (active && useOrgStore.getState().currentOrg?.id === id)
          setOrgCurrency(res.data.data.settings?.currency ?? 'USD')
      })
      .catch(() => {})
    return () => { active = false }
  }, [workspaceId, workspaceCurrency])

  function switchOrg(org: Organization) {
    setCurrentOrg(org)
    setOrgMenuOpen(false)
    navigate('/dashboard')
  }

  async function handleLogout() {
    setLogoutFailed(false)
    setSigningOut(true)
    try {
      if (await auth.signOut()) navigate('/login', { replace: true })
    } catch {
      setLogoutFailed(true)
    } finally {
      setSigningOut(false)
    }
  }

  const workspace = (
    <div ref={orgMenuRef} className="relative">
      <button
        className="workspace-switch"
        disabled={organizations.length < 2}
        aria-label={t('design.switchWorkspace')}
        aria-expanded={orgMenuOpen}
        onClick={() => setOrgMenuOpen(!orgMenuOpen)}
      >
        <span className="workspace-avatar">
          {currentOrg?.name.slice(0, 2).toUpperCase() ?? 'CA'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-primary">
            {currentOrg?.name ?? t('design.workspace')}
          </span>
          <span className="mt-1 block text-[10px] text-muted">
            {t('header.platformTitle')}
          </span>
        </span>
        {organizations.length > 1 && (
          <ChevronDown size={14} className="text-muted" />
        )}
      </button>
      {orgMenuOpen && (
        <div className="absolute left-4 right-4 top-[calc(100%+8px)] z-50 overflow-hidden rounded-xl border border-edge bg-surface p-1 shadow-popover">
          {organizations.map((org) => (
            <button
              key={org.id}
              onClick={() => switchOrg(org)}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-xs text-secondary hover:bg-subtle"
            >
              <span className="truncate">{org.name}</span>
              {org.id === currentOrg?.id && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  const sidebarContents = (mobile: boolean) => (
    <>
      <div className="sidebar-brand">
        <Brand />
        {mobile && (
          <button
            className="icon-button"
            onClick={() => setMobileNavOpen(false)}
            aria-label={t('design.closeNavigation')}
          >
            <X size={18} />
          </button>
        )}
      </div>
      {workspace}
      <nav
        aria-label={t('design.primaryNavigation')}
        className="sidebar-navigation"
      >
        {navSections.map((section) => (
          <NavSection
            key={section.key}
            section={section}
            onNavigate={() => setMobileNavOpen(false)}
          />
        ))}
      </nav>
      <div className="border-t border-edge px-3 py-2">
        <button type="button" className="nav-link w-full" onClick={handleLogout} disabled={signingOut}>
          <LogOut size={16} />
          {t('common.logout')}
        </button>
        {logoutFailed && <p role="alert" className="mt-2 text-xs text-danger">{t('common.logoutError')}</p>}
      </div>
    </>
  )

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        {t('design.skipToContent')}
      </a>
      <aside className="app-sidebar">
        {!mobileNavOpen && sidebarContents(false)}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="app-header">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={(event) => {
                event.currentTarget.focus()
                setMobileNavOpen(true)
              }}
              aria-label={t('design.openNavigation')}
              aria-expanded={mobileNavOpen}
              className="icon-button lg:hidden"
            >
              <Menu size={20} />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="hidden text-muted xl:inline">
                {currentSection
                  ? t(currentSection.key)
                  : t('header.platformTitle')}
              </span>
              <ChevronRight size={13} className="hidden text-muted xl:block" />
              <span className="truncate font-medium text-primary">
                {currentItem ? t(currentItem.labelKey) : 'CloudAtlas'}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <button
              className="search-trigger"
              onClick={(event) => {
                event.currentTarget.focus()
                setSearchOpen(true)
              }}
              aria-label={t('common.search')}
            >
              <Search size={16} />
              <span className="mr-5 hidden md:inline">
                {t('design.searchAnything')}
              </span>
              <kbd className="hidden rounded border border-edge bg-surface px-1 py-0.5 text-[10px] md:inline">
                ⌘ K
              </kbd>
            </button>
            <span className="mx-1 hidden h-5 w-px bg-edge sm:block" />
            <NavLink to={`/help?article=${helpForPath(pathname)}`} className="icon-button" title={t('help.context')} aria-label={t('help.context')}><CircleHelp size={18} /></NavLink>
            <NotificationBell />
            <span className="hidden sm:contents">
              <BackgroundJobsIndicator />
            </span>
            <button
              onClick={switchLanguage}
              title={t('header.switchLanguage')}
              aria-label={t('header.switchLanguage')}
              className="icon-button text-[11px] font-semibold"
            >
              {i18n.language === 'zh' ? 'EN' : t('common.languageName')}
            </button>
            <button
              onClick={toggleTheme}
              title={
                theme === 'dark'
                  ? t('header.themeToLight')
                  : t('header.themeToDark')
              }
              aria-label={
                theme === 'dark'
                  ? t('header.themeToLight')
                  : t('header.themeToDark')
              }
              className="icon-button"
            >
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </header>
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="app-main"
        >
          <div className="page-content">
            <Suspense
              fallback={
                <div
                  className="space-y-5"
                  role="status"
                  aria-label={t('common.loading')}
                >
                  <div className="skeleton h-9 w-52" />
                  <div className="skeleton h-36" />
                  <div className="skeleton h-80" />
                </div>
              }
            >
              <ErrorBoundary key={`${currentOrg?.id ?? 'none'}:${pathname}`} embedded>
                <Outlet />
              </ErrorBoundary>
            </Suspense>
          </div>
          <footer className="app-footer">
            <span>CloudAtlas</span>
            <span>{t('design.footer')}</span>
          </footer>
        </main>
      </div>
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <aside
            ref={mobileNavRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('design.primaryNavigation')}
            tabIndex={-1}
            className="mobile-nav"
          >
            {sidebarContents(true)}
          </aside>
        </div>
      )}
      <CopilotFab />
      <CopilotPanel key={currentOrg?.id ?? 'no-workspace'} />
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  )
}
