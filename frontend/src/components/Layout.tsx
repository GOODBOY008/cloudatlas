import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ChevronDown,
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
  { to: '/shared-environments', labelKey: 'nav.sharedEnvironments', icon: Globe },
  { to: '/resource-lifecycle', labelKey: 'nav.resourceLifecycle', icon: RefreshCw },
  { to: '/k8s-rightsizing', labelKey: 'nav.k8sRightsizing', icon: Container },
  { to: '/archive', labelKey: 'nav.archive', icon: Archive },
]

const assetInventoryNavItems: NavItem[] = [
  { to: '/cmdb', labelKey: 'nav.cmdb', icon: Server },
  { to: '/services', labelKey: 'nav.services', icon: Puzzle },
  { to: '/dynamic-groups', labelKey: 'nav.dynamicGroups', icon: Target },
  { to: '/ci-types', labelKey: 'nav.ciTypes', icon: Type },
  { to: '/ci-classifications', labelKey: 'nav.classifications', icon: FolderTree },
  { to: '/association-kinds', labelKey: 'nav.associations', icon: Link },
  { to: '/model-topology', labelKey: 'nav.modelTopology', icon: Network },
  { to: '/service-templates', labelKey: 'nav.serviceTemplates', icon: ClipboardList },
  { to: '/ci-topology', labelKey: 'nav.ciTopology', icon: Network },
  { to: '/field-templates', labelKey: 'nav.fieldTemplates', icon: Layers },
  { to: '/ci-import', labelKey: 'nav.ciImport', icon: Download },
  { to: '/cmdb-stats', labelKey: 'nav.inventoryStats', icon: BarChart3 },
  { to: '/external-cmdb', labelKey: 'nav.externalCmdb', icon: Network },
]

const governanceNavItems: NavItem[] = [
  { to: '/compliance', labelKey: 'nav.compliance', icon: ShieldCheck },
  { to: '/tagging-coverage', labelKey: 'nav.taggingCoverage', icon: Tags },
  { to: '/tagging-policies', labelKey: 'nav.taggingPolicies', icon: BookMarked },
  { to: '/constraints', labelKey: 'nav.constraints', icon: TrafficCone },
  { to: '/drift', labelKey: 'nav.drift', icon: Wind },
  { to: '/anomaly-detection', labelKey: 'nav.anomalyDetection', icon: AlertTriangle },
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

const navCls = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
    isActive
      ? 'bg-indigo-600 text-white'
      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
  }`

function NavSection({ labelKey }: { labelKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="pt-3 pb-1">
      <p className="px-3 text-xs font-semibold uppercase text-gray-400 dark:text-gray-600 tracking-wider">{t(labelKey)}</p>
    </div>
  )
}

function NavGroup({ items }: { items: NavItem[] }) {
  const { t } = useTranslation()
  return (
    <>
      {items.map(({ to, labelKey, icon: Icon }) => (
        <NavLink key={to} to={to} className={navCls}>
          <Icon size={18} />
          {t(labelKey)}
        </NavLink>
      ))}
    </>
  )
}

export default function Layout() {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation()
  const { organizations, currentOrg, setOrganizations, setCurrentOrg } = useOrgStore()
  const [orgMenuOpen, setOrgMenuOpen] = useState(false)
  const { theme, toggleTheme } = useThemeStore()
  const toggleCopilot = useCopilotStore((s) => s.toggle)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  function switchLanguage() {
    const next = i18n.language === 'zh' ? 'en' : 'zh'
    i18n.changeLanguage(next)
    setStoredLanguage(next)
    syncHtmlLang(next)
  }

  // Sync theme class on <html>
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [theme])

  useEffect(() => {
    api.get<{ data: Organization[] }>('/organizations')
      .then((res) => {
        setOrganizations(res.data.data ?? [])
        // Restore the last-used org when available.
        const saved = window.localStorage.getItem('cloudatlas-org')
        const orgs = res.data.data ?? []
        const match = orgs.find((o) => o.id === saved)
        if (match) {
          setCurrentOrg(match)
          loadOrgCurrency(match.id)
        }
      })
      .catch(() => {/* graceful: org not required for all pages */})
  }, [setOrganizations, setCurrentOrg])

  function switchOrg(org: Organization) {
    setCurrentOrg(org)
    window.localStorage.setItem('cloudatlas-org', org.id)
    setOrgMenuOpen(false)
    loadOrgCurrency(org.id)
    navigate('/dashboard')
  }

  function loadOrgCurrency(orgIdToLoad: string) {
    api
      .get<{ data: { settings?: { currency?: string } } }>(`/organizations/${orgIdToLoad}`)
      .then((res) => setOrgCurrency(res.data.data.settings?.currency ?? 'USD'))
      .catch(() => {})
  }

  function handleLogout() {
    auth.clearTokens()
    navigate('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-100 dark:bg-gray-950 transition-colors duration-200">
      {/* Sidebar */}
      <aside className="hidden lg:flex w-56 flex-shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col transition-colors duration-200">
        <div className="px-5 py-5 border-b border-gray-200 dark:border-gray-800">
          <span className="text-xl font-bold text-indigo-500 dark:text-indigo-400">☁ CloudAtlas</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <NavSection labelKey="nav.section.overview" />
          <NavGroup items={overviewNavItems} />

          <NavSection labelKey="nav.section.costManagement" />
          <NavGroup items={costManagementNavItems} />

          <NavSection labelKey="nav.section.resourceManagement" />
          <NavGroup items={resourceManagementNavItems} />

          <NavSection labelKey="nav.section.assetInventory" />
          <NavGroup items={assetInventoryNavItems} />

          <NavSection labelKey="nav.section.governance" />
          <NavGroup items={governanceNavItems} />

          <NavSection labelKey="nav.section.administration" />
          <NavGroup items={administrationNavItems} />
        </nav>
        <div className="px-3 py-4 border-t border-gray-200 dark:border-gray-800">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <LogOut size={18} />
            {t('common.logout')}
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 flex-shrink-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-6 transition-colors duration-200">
          <h1 className="text-sm text-gray-500 dark:text-gray-400">{t('header.platformTitle')}</h1>
          <div className="flex items-center gap-2">
            {/* Mobile nav toggle */}
            <button
              onClick={() => setMobileNavOpen(true)}
              aria-label="Menu"
              className="lg:hidden w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <Menu size={18} />
            </button>
            {/* Org switcher */}
            {organizations.length > 1 && (
              <div className="relative">
                <button
                  onClick={() => setOrgMenuOpen((v) => !v)}
                  className="flex items-center gap-1 h-9 px-3 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <span className="max-w-[140px] truncate">{currentOrg?.name ?? '…'}</span>
                  <ChevronDown size={14} />
                </button>
                {orgMenuOpen && (
                  <div className="absolute right-0 top-11 w-56 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden z-50">
                    {organizations.map((o) => (
                      <button
                        key={o.id}
                        onClick={() => switchOrg(o)}
                        className={`w-full text-left px-4 py-2.5 text-sm hover:bg-gray-800 transition-colors ${
                          o.id === currentOrg?.id ? 'text-indigo-400' : 'text-white'
                        }`}
                      >
                        {o.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Notifications */}
            <NotificationBell />
            {/* Background jobs (async discovery / billing import) */}
            <BackgroundJobsIndicator />
            {/* Copilot toggle (labeled — sparkle icons alone test poorly for discoverability) */}
            <button
              onClick={toggleCopilot}
              title={`${t('copilot.title')} (⌘/Ctrl+I)`}
              className="hidden lg:flex h-9 px-3 items-center gap-1.5 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              <Sparkles size={16} className="text-indigo-500 dark:text-indigo-400" />
              {t('copilot.title')}
            </button>
            {/* Language switcher */}
            <button
              onClick={switchLanguage}
              title={t('header.switchLanguage')}
              className="h-9 px-3 flex items-center justify-center rounded-lg text-xs font-semibold text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              {i18n.language === 'zh' ? 'EN' : t('common.languageName')}
            </button>
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              title={theme === 'dark' ? t('header.themeToLight') : t('header.themeToDark')}
              className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
            {theme === 'dark' ? (
              /* Sun icon */
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4"/>
                <line x1="12" y1="2" x2="12" y2="6"/>
                <line x1="12" y1="18" x2="12" y2="22"/>
                <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/>
                <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
                <line x1="2" y1="12" x2="6" y2="12"/>
                <line x1="18" y1="12" x2="22" y2="12"/>
                <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/>
                <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
              </svg>
            ) : (
              /* Moon icon */
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      {/* Mobile nav drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileNavOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col overflow-y-auto shadow-2xl">
            <div className="px-5 py-5 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
              <span className="text-lg font-bold text-indigo-500 dark:text-indigo-400">☁ CloudAtlas</span>
              <button onClick={() => setMobileNavOpen(false)} aria-label="Close" className="text-gray-400 hover:text-gray-200">
                <X size={18} />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1">
              <NavSection labelKey="nav.section.overview" />
              <NavGroup items={overviewNavItems} />
              <NavSection labelKey="nav.section.costManagement" />
              <NavGroup items={costManagementNavItems} />
              <NavSection labelKey="nav.section.resourceManagement" />
              <NavGroup items={resourceManagementNavItems} />
              <NavSection labelKey="nav.section.assetInventory" />
              <NavGroup items={assetInventoryNavItems} />
              <NavSection labelKey="nav.section.governance" />
              <NavGroup items={governanceNavItems} />
              <NavSection labelKey="nav.section.administration" />
              <NavGroup items={administrationNavItems} />
            </nav>
          </aside>
        </div>
      )}
      <CopilotFab />
      <CopilotPanel />
      <GlobalSearch />
    </div>
  )
}
