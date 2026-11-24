import { Badge } from '@cloudflare/kumo/components/badge'
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from './shared/SelectField'
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { CircleHelp, ChevronDown, ChevronsUpDown, Globe, Check, Search, Sun, Moon, Menu, X, LogOut } from 'lucide-react'
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
  const { theme, toggleTheme } = useThemeStore()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [logoutFailed, setLogoutFailed] = useState(false)
  const mobileNavRef = useDialogFocus<HTMLElement>(mobileNavOpen, () =>
    setMobileNavOpen(false),
  )
  const mainRef = useRef<HTMLElement>(null)
  const currentItem = routeForPath(pathname)
  const currentSection = navSections.find((section) => section.key === currentItem?.section)

  useEffect(() => {
    setMobileNavOpen(false)
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
  // Resolving the first workspace keeps the mounted page and its focused
  // inputs. Switching or clearing an established workspace discards its drafts.
  const [firstWorkspaceId, setFirstWorkspaceId] = useState(workspaceId)
  if (firstWorkspaceId === undefined && workspaceId !== undefined) setFirstWorkspaceId(workspaceId)
  const pageScope = workspaceId === firstWorkspaceId ? 'initial' : workspaceId ?? 'none'
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

  const workspaceName = currentOrg?.workspace?.name || currentOrg?.name
  const workspaceKey = (org: Organization) => org.workspace?.id || org.id
  const workspaces = organizations.filter((org, i, all) => all.findIndex(x => workspaceKey(x) === workspaceKey(org)) === i)
  const environments = organizations.filter(org => org.workspace && org.workspace.id === currentOrg?.workspace?.id)
  const workspace = (
    <div className="workspace-selector">
      <DropdownMenu>
        <DropdownMenu.Trigger
          disabled={workspaces.length < 2}
          aria-label={t('design.switchWorkspace')}
          render={<button type="button" className="workspace-trigger" />}
        >
          <Globe size={16} aria-hidden="true" />
          <span className="truncate">{workspaceName ?? t('design.workspace')}</span>
          {workspaces.length > 1 && <ChevronsUpDown size={14} aria-hidden="true" />}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start">
          {workspaces.map(org => (
            <DropdownMenu.Item key={org.id} onClick={() => switchOrg(org)}>
              {org.workspace?.name || org.name}
              {currentOrg && workspaceKey(org) === workspaceKey(currentOrg) && <Check size={14} className="ml-auto" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )

  const sidebarContents = (mobile: boolean) => (
    <>
      {mobile && (
        <div className="sidebar-brand">
          <Brand />
          <Button variant="ghost" shape="square" onClick={() => setMobileNavOpen(false)} aria-label={t('design.closeNavigation')}>
            <X size={18} />
          </Button>
        </div>
      )}
      {currentOrg?.workspace && (environments.length > 1 ? (
        <div className="workspace-environment">
          <SelectField
            id="workspace-environment"
            label={t('design.environment')}
            value={currentOrg.id}
            onValueChange={id => {
              const org = environments.find(item => item.id === id)
              if (org) switchOrg(org)
            }}
            items={environments.map(org => ({ value: org.id, label: org.workspace?.environment }))}
          />
        </div>
      ) : (
        <div className="workspace-context">
          <span>{t('design.environment')}</span>
          <Badge variant="secondary">{currentOrg.workspace.environment}</Badge>
        </div>
      ))}
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
      <header className="app-header">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" shape="square"
            onClick={(event) => {
              event.currentTarget.focus()
              setMobileNavOpen(true)
            }}
            aria-label={t('design.openNavigation')}
            aria-expanded={mobileNavOpen}
            className="lg:hidden"
          >
            <Menu size={20} />
          </Button>
          <NavLink to="/dashboard" aria-label="CloudAtlas" className="header-brand"><Brand /></NavLink>
          {workspace}
        </div>
        <div className="header-actions">
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
          <Button variant="ghost" shape="square"
            onClick={switchLanguage}
            title={t('header.switchLanguage')}
            aria-label={t('header.switchLanguage')}
            className="text-xs"
          >
            {i18n.language === 'zh' ? 'EN' : t('common.languageName')}
          </Button>
          <Button variant="ghost" shape="square"
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
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="app-sidebar">{!mobileNavOpen && sidebarContents(false)}</aside>
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="app-main"
        >
          <div className="page-content">
            {currentSection && <p className="page-crumb">{t(currentSection.key)}</p>}
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
              <ErrorBoundary key={`${pageScope}:${pathname}`} resetKey={workspaceId} embedded>
                <Outlet />
              </ErrorBoundary>
            </Suspense>
          </div>
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
