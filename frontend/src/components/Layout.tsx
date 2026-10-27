import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Check,
  Search,
  Sun,
  Moon,
  Menu,
  X,
  Archive,
  ArrowLeftRight,
  BarChart3,
  Bell,
  Boxes,
  Building2,
  BookMarked,
  ClipboardList,
  Clock,
  Cloud,
  Container,
  Database,
  DollarSign,
  Download,
  FileSpreadsheet,
  FolderTree,
  Globe,
  History,
  LayoutDashboard,
  Layers,
  Lightbulb,
  Link,
  ListChecks,
  LogOut,
  Map,
  Network,
  Puzzle,
  RadioTower,
  RefreshCw,
  Scale,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Target,
  TrafficCone,
  Type,
  UploadCloud,
  Wallet,
  Webhook,
  Wind,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import CopilotPanel from './CopilotPanel'
import CopilotFab from './copilot/CopilotFab'
import NotificationBell from './NotificationBell'
import BackgroundJobsIndicator from './BackgroundJobsIndicator'
import GlobalSearch from './GlobalSearch'
import { setOrgCurrency } from '../lib/format'
import { auth } from '../lib/auth'
import api from '../lib/api'
import { setStoredLanguage, syncHtmlLang } from '../i18n'
import { useOrgStore } from '../store/orgStore'
import { useCopilotStore } from '../store/copilotStore'
import { useThemeStore } from '../store/themeStore'
import Brand from './Brand'
import { useDialogFocus } from '../lib/hooks/useDialogFocus'
import type { Organization } from '../types'

type NavItem = { to: string; labelKey: string; icon: LucideIcon }

const overviewNavItems: NavItem[] = [
  { to: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/recommendations', labelKey: 'nav.recommendations', icon: Lightbulb },
  { to: '/checklist', labelKey: 'nav.checklist', icon: ListChecks },
  { to: '/ai-center', labelKey: 'nav.aiCenter', icon: Sparkles },
]

const costManagementNavItems: NavItem[] = [
  { to: '/expenses', labelKey: 'nav.expenses', icon: DollarSign },
  { to: '/cost-map', labelKey: 'nav.costMap', icon: Map },
  { to: '/showback', labelKey: 'nav.showback', icon: ArrowLeftRight },
  { to: '/quotas-budgets', labelKey: 'nav.budgetsQuotas', icon: Wallet },
  { to: '/cost-comparison', labelKey: 'nav.costComparison', icon: Scale },
  { to: '/s3-duplicates', labelKey: 'nav.s3Duplicates', icon: Database },
  { to: '/bi-export', labelKey: 'nav.biExport', icon: FileSpreadsheet },
]

const resourceManagementNavItems: NavItem[] = [
  { to: '/resources', labelKey: 'nav.resources', icon: Boxes },
  { to: '/pools', labelKey: 'nav.pools', icon: Layers },
  {
    to: '/shared-environments',
    labelKey: 'nav.sharedEnvironments',
    icon: Globe,
  },
  {
    to: '/resource-lifecycle',
    labelKey: 'nav.resourceLifecycle',
    icon: RefreshCw,
  },
  { to: '/k8s-rightsizing', labelKey: 'nav.k8sRightsizing', icon: Container },
  { to: '/archive', labelKey: 'nav.archive', icon: Archive },
]

const assetInventoryNavItems: NavItem[] = [
  { to: '/cmdb', labelKey: 'nav.cmdb', icon: Server },
  { to: '/services', labelKey: 'nav.services', icon: Puzzle },
  { to: '/dynamic-groups', labelKey: 'nav.dynamicGroups', icon: Target },
  { to: '/ci-types', labelKey: 'nav.ciTypes', icon: Type },
  {
    to: '/ci-classifications',
    labelKey: 'nav.classifications',
    icon: FolderTree,
  },
  { to: '/association-kinds', labelKey: 'nav.associations', icon: Link },
  { to: '/model-topology', labelKey: 'nav.modelTopology', icon: Network },
  {
    to: '/service-templates',
    labelKey: 'nav.serviceTemplates',
    icon: ClipboardList,
  },
  { to: '/ci-topology', labelKey: 'nav.ciTopology', icon: Network },
  { to: '/field-templates', labelKey: 'nav.fieldTemplates', icon: Layers },
  { to: '/ci-import', labelKey: 'nav.ciImport', icon: Download },
  { to: '/cmdb-stats', labelKey: 'nav.inventoryStats', icon: BarChart3 },
  { to: '/external-cmdb', labelKey: 'nav.externalCmdb', icon: Network },
]

const governanceNavItems: NavItem[] = [
  { to: '/compliance', labelKey: 'nav.compliance', icon: ShieldCheck },
  { to: '/tagging-coverage', labelKey: 'nav.taggingCoverage', icon: Tags },
  {
    to: '/tagging-policies',
    labelKey: 'nav.taggingPolicies',
    icon: BookMarked,
  },
  { to: '/constraints', labelKey: 'nav.constraints', icon: TrafficCone },
  { to: '/drift', labelKey: 'nav.drift', icon: Wind },
  {
    to: '/anomaly-detection',
    labelKey: 'nav.anomalyDetection',
    icon: AlertTriangle,
  },
  { to: '/schedules', labelKey: 'nav.powerSchedules', icon: Clock },
  { to: '/ci-apply-rules', labelKey: 'nav.applyRules', icon: Zap },
]

const administrationNavItems: NavItem[] = [
  { to: '/cloud-accounts', labelKey: 'nav.cloudAccounts', icon: Cloud },
  { to: '/billing-import', labelKey: 'nav.billingImport', icon: UploadCloud },
  { to: '/cost-centers', labelKey: 'nav.costCenters', icon: Building2 },
  { to: '/alerts', labelKey: 'nav.alerts', icon: Bell },
  { to: '/alert-events', labelKey: 'nav.alertEvents', icon: History },
  { to: '/events', labelKey: 'nav.events', icon: RadioTower },
  { to: '/webhooks', labelKey: 'nav.webhooks', icon: Webhook },
  { to: '/integrations', labelKey: 'nav.integrations', icon: Puzzle },
  { to: '/rules', labelKey: 'nav.rules', icon: SlidersHorizontal },
  { to: '/settings', labelKey: 'nav.settings', icon: Settings },
]

const navSections = [
  { key: 'nav.section.overview', items: overviewNavItems },
  { key: 'nav.section.costManagement', items: costManagementNavItems },
  { key: 'nav.section.resourceManagement', items: resourceManagementNavItems },
  { key: 'nav.section.assetInventory', items: assetInventoryNavItems },
  { key: 'nav.section.governance', items: governanceNavItems },
  { key: 'nav.section.administration', items: administrationNavItems },
]

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
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
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
    <div>
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
        <div className="space-y-0.5">
          {section.items.map(({ to, labelKey, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onNavigate}
              className={({ isActive }) =>
                `nav-link ${isActive ? 'active' : ''}`
              }
            >
              <Icon size={17} />
              <span className="truncate">{t(labelKey)}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Layout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { t, i18n } = useTranslation()
  const { organizations, currentOrg, setOrganizations, setCurrentOrg } =
    useOrgStore()
  const [orgMenuOpen, setOrgMenuOpen] = useState(false)
  const { theme, toggleTheme } = useThemeStore()
  const toggleCopilot = useCopilotStore((s) => s.toggle)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const orgMenuRef = useRef<HTMLDivElement>(null)
  const mobileNavRef = useDialogFocus<HTMLElement>(mobileNavOpen, () =>
    setMobileNavOpen(false),
  )
  const mainRef = useRef<HTMLElement>(null)
  const currentSection = navSections.find((section) =>
    section.items.some(
      (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
    ),
  )
  const currentItem = currentSection?.items.find(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  )

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
    i18n.changeLanguage(next)
    setStoredLanguage(next)
    syncHtmlLang(next)
  }

  useEffect(() => {
    api
      .get<{ data: Organization[] }>('/organizations')
      .then((res) => {
        const orgs = res.data.data ?? []
        setOrganizations(orgs)
        const selected = useOrgStore.getState().currentOrg
        if (selected) loadOrgCurrency(selected.id)
      })
      .catch(() => {
        /* Some pages can be used without an organization. */
      })
  }, [setOrganizations])

  function switchOrg(org: Organization) {
    setCurrentOrg(org)
    setOrgMenuOpen(false)
    loadOrgCurrency(org.id)
    navigate('/dashboard')
  }

  function loadOrgCurrency(id: string) {
    api
      .get<{ data: { settings?: { currency?: string } } }>(
        `/organizations/${id}`,
      )
      .then((res) => setOrgCurrency(res.data.data.settings?.currency ?? 'USD'))
      .catch(() => {})
  }

  function handleLogout() {
    auth.clearTokens()
    navigate('/login')
  }

  const workspace = (
    <div ref={orgMenuRef} className="relative">
      <button
        className="workspace-switch w-[calc(100%-2rem)]"
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
      <div className="flex h-[88px] shrink-0 items-center justify-between px-5">
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
        className="flex-1 overflow-y-auto px-4 pb-5 pt-1"
      >
        {navSections.map((section) => (
          <NavSection
            key={section.key}
            section={section}
            onNavigate={() => setMobileNavOpen(false)}
          />
        ))}
      </nav>
      <div className="mx-4 mb-4 rounded-xl border border-edge bg-canvas p-3.5">
        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-primary">
          <Sparkles size={14} className="text-accent" />
          {t('design.copilotHeading')}
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-muted">
          {t('design.copilotDescription')}
        </p>
        <button
          className="text-link"
          onClick={() => {
            setMobileNavOpen(false)
            toggleCopilot()
          }}
        >
          {t('design.openCopilot')}
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="border-t border-edge px-4 py-3">
        <button className="nav-link w-full" onClick={handleLogout}>
          <LogOut size={16} />
          {t('common.logout')}
        </button>
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
              onClick={() => setMobileNavOpen(true)}
              aria-label="Menu"
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
              className="search-trigger !border-transparent !bg-transparent !px-2 md:!border-edge md:!bg-canvas md:!px-3"
              onClick={() => setSearchOpen(true)}
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
              <Outlet />
            </Suspense>
          </div>
          <footer className="mt-10 flex items-center justify-between border-t border-edge pt-5 text-[10px] text-muted">
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
      <CopilotPanel />
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  )
}
