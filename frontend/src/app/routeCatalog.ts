import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { Activity, AlertTriangle, Archive, ArrowLeftRight, BarChart3, Bell, BookMarked, Boxes, Building2, CircleHelp, ClipboardList, Clock, Cloud, Container, Database, DollarSign, Download, FileSpreadsheet, FolderTree, Globe, History, Layers, LayoutDashboard, Lightbulb, Link, ListChecks, Map, Network, Puzzle, RadioTower, RefreshCw, Scale, Server, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Tags, Target, TrafficCone, Type, UploadCloud, Wallet, Webhook, Wind, Zap, type LucideIcon } from 'lucide-react'

/** One catalog owns route loading, navigation, search, breadcrumbs and contextual help. */
export interface ProductRoute {
  path: string
  labelKey: string
  section: string
  icon: LucideIcon
  component: LazyExoticComponent<ComponentType>
  help: string
  navigation?: false
}

export const productRoutes: ProductRoute[] = [
  { path: '/dashboard', labelKey: 'nav.dashboard', section: 'nav.section.overview', icon: LayoutDashboard, component: lazy(() => import('../pages/Dashboard')), help: 'start' },
  { path: '/data-flow', labelKey: 'nav.dataFlow', section: 'nav.section.overview', icon: Activity, component: lazy(() => import('../pages/DataFlow')), help: 'data-flow' },
  { path: '/recommendations', labelKey: 'nav.recommendations', section: 'nav.section.overview', icon: Lightbulb, component: lazy(() => import('../pages/Recommendations')), help: 'finops' },
  { path: '/checklist', labelKey: 'nav.checklist', section: 'nav.section.overview', icon: ListChecks, component: lazy(() => import('../pages/Checklist')), help: 'start' },
  { path: '/ai-center', labelKey: 'nav.aiCenter', section: 'nav.section.overview', icon: Sparkles, component: lazy(() => import('../pages/AICenter')), help: 'start' },
  { path: '/expenses', labelKey: 'nav.expenses', section: 'nav.section.costManagement', icon: DollarSign, component: lazy(() => import('../pages/Expenses')), help: 'finops' },
  { path: '/cost-map', labelKey: 'nav.costMap', section: 'nav.section.costManagement', icon: Map, component: lazy(() => import('../pages/CostMap')), help: 'finops' },
  { path: '/showback', labelKey: 'nav.showback', section: 'nav.section.costManagement', icon: ArrowLeftRight, component: lazy(() => import('../pages/Showback')), help: 'allocation' },
  { path: '/quotas-budgets', labelKey: 'nav.budgetsQuotas', section: 'nav.section.costManagement', icon: Wallet, component: lazy(() => import('../pages/QuotasBudgets')), help: 'finops' },
  { path: '/cost-comparison', labelKey: 'nav.costComparison', section: 'nav.section.costManagement', icon: Scale, component: lazy(() => import('../pages/CostComparison')), help: 'finops' },
  { path: '/s3-duplicates', labelKey: 'nav.s3Duplicates', section: 'nav.section.costManagement', icon: Database, component: lazy(() => import('../pages/S3Duplicates')), help: 'finops' },
  { path: '/bi-export', labelKey: 'nav.biExport', section: 'nav.section.costManagement', icon: FileSpreadsheet, component: lazy(() => import('../pages/BIExport')), help: 'finops' },
  { path: '/resources', labelKey: 'nav.resources', section: 'nav.section.resourceManagement', icon: Boxes, component: lazy(() => import('../pages/Resources')), help: 'start' },
  { path: '/pools', labelKey: 'nav.pools', section: 'nav.section.resourceManagement', icon: Layers, component: lazy(() => import('../pages/Pools')), help: 'allocation' },
  { path: '/shared-environments', labelKey: 'nav.sharedEnvironments', section: 'nav.section.resourceManagement', icon: Globe, component: lazy(() => import('../pages/SharedEnvironments')), help: 'start' },
  { path: '/resource-lifecycle', labelKey: 'nav.resourceLifecycle', section: 'nav.section.resourceManagement', icon: RefreshCw, component: lazy(() => import('../pages/ResourceLifecycle')), help: 'start' },
  { path: '/k8s-rightsizing', labelKey: 'nav.k8sRightsizing', section: 'nav.section.resourceManagement', icon: Container, component: lazy(() => import('../pages/K8sRightsizing')), help: 'start' },
  { path: '/archive', labelKey: 'nav.archive', section: 'nav.section.resourceManagement', icon: Archive, component: lazy(() => import('../pages/Archive')), help: 'start' },
  { path: '/cmdb', labelKey: 'nav.cmdb', section: 'nav.section.assetInventory', icon: Server, component: lazy(() => import('../pages/CMDB')), help: 'cmdb' },
  { path: '/services', labelKey: 'nav.services', section: 'nav.section.assetInventory', icon: Puzzle, component: lazy(() => import('../pages/Services')), help: 'allocation' },
  { path: '/dynamic-groups', labelKey: 'nav.dynamicGroups', section: 'nav.section.assetInventory', icon: Target, component: lazy(() => import('../pages/DynamicGroups')), help: 'cmdb' },
  { path: '/ci-types', labelKey: 'nav.ciTypes', section: 'nav.section.assetInventory', icon: Type, component: lazy(() => import('../pages/CITypes')), help: 'cmdb' },
  { path: '/ci-classifications', labelKey: 'nav.classifications', section: 'nav.section.assetInventory', icon: FolderTree, component: lazy(() => import('../pages/CIClassifications')), help: 'cmdb' },
  { path: '/association-kinds', labelKey: 'nav.associations', section: 'nav.section.assetInventory', icon: Link, component: lazy(() => import('../pages/AssociationKinds')), help: 'cmdb' },
  { path: '/model-topology', labelKey: 'nav.modelTopology', section: 'nav.section.assetInventory', icon: Network, component: lazy(() => import('../pages/ModelTopology')), help: 'cmdb' },
  { path: '/service-templates', labelKey: 'nav.serviceTemplates', section: 'nav.section.assetInventory', icon: ClipboardList, component: lazy(() => import('../pages/ServiceTemplates')), help: 'cmdb' },
  { path: '/ci-topology', labelKey: 'nav.ciTopology', section: 'nav.section.assetInventory', icon: Network, component: lazy(() => import('../pages/CITopology')), help: 'cmdb' },
  { path: '/field-templates', labelKey: 'nav.fieldTemplates', section: 'nav.section.assetInventory', icon: Layers, component: lazy(() => import('../pages/FieldTemplates')), help: 'cmdb' },
  { path: '/ci-import', labelKey: 'nav.ciImport', section: 'nav.section.assetInventory', icon: Download, component: lazy(() => import('../pages/CIImport')), help: 'cmdb' },
  { path: '/cmdb-stats', labelKey: 'nav.inventoryStats', section: 'nav.section.assetInventory', icon: BarChart3, component: lazy(() => import('../pages/CMDBStats')), help: 'cmdb' },
  { path: '/external-cmdb', labelKey: 'nav.externalCmdb', section: 'nav.section.assetInventory', icon: Network, component: lazy(() => import('../pages/ExternalCMDB')), help: 'cmdb' },
  { path: '/compliance', labelKey: 'nav.compliance', section: 'nav.section.governance', icon: ShieldCheck, component: lazy(() => import('../pages/Compliance')), help: 'cmdb' },
  { path: '/tagging-coverage', labelKey: 'nav.taggingCoverage', section: 'nav.section.governance', icon: Tags, component: lazy(() => import('../pages/TaggingCoverage')), help: 'finops' },
  { path: '/tagging-policies', labelKey: 'nav.taggingPolicies', section: 'nav.section.governance', icon: BookMarked, component: lazy(() => import('../pages/TaggingPolicies')), help: 'finops' },
  { path: '/constraints', labelKey: 'nav.constraints', section: 'nav.section.governance', icon: TrafficCone, component: lazy(() => import('../pages/Constraints')), help: 'start' },
  { path: '/drift', labelKey: 'nav.drift', section: 'nav.section.governance', icon: Wind, component: lazy(() => import('../pages/DriftDetection')), help: 'cmdb' },
  { path: '/anomaly-detection', labelKey: 'nav.anomalyDetection', section: 'nav.section.governance', icon: AlertTriangle, component: lazy(() => import('../pages/AnomalyDetection')), help: 'finops' },
  { path: '/schedules', labelKey: 'nav.powerSchedules', section: 'nav.section.governance', icon: Clock, component: lazy(() => import('../pages/PowerSchedules')), help: 'start' },
  { path: '/ci-apply-rules', labelKey: 'nav.applyRules', section: 'nav.section.governance', icon: Zap, component: lazy(() => import('../pages/CIApplyRules')), help: 'cmdb' },
  { path: '/cloud-accounts', labelKey: 'nav.cloudAccounts', section: 'nav.section.administration', icon: Cloud, component: lazy(() => import('../pages/CloudAccounts')), help: 'start' },
  { path: '/billing-import', labelKey: 'nav.billingImport', section: 'nav.section.administration', icon: UploadCloud, component: lazy(() => import('../pages/BillingImport')), help: 'finops' },
  { path: '/cost-centers', labelKey: 'nav.costCenters', section: 'nav.section.administration', icon: Building2, component: lazy(() => import('../pages/CostCenters')), help: 'allocation' },
  { path: '/alerts', labelKey: 'nav.alerts', section: 'nav.section.administration', icon: Bell, component: lazy(() => import('../pages/Alerts')), help: 'start' },
  { path: '/alert-events', labelKey: 'nav.alertEvents', section: 'nav.section.administration', icon: History, component: lazy(() => import('../pages/AlertEvents')), help: 'start' },
  { path: '/events', labelKey: 'nav.events', section: 'nav.section.administration', icon: RadioTower, component: lazy(() => import('../pages/Events')), help: 'start' },
  { path: '/webhooks', labelKey: 'nav.webhooks', section: 'nav.section.administration', icon: Webhook, component: lazy(() => import('../pages/Webhooks')), help: 'start' },
  { path: '/integrations', labelKey: 'nav.integrations', section: 'nav.section.administration', icon: Puzzle, component: lazy(() => import('../pages/Integrations')), help: 'start' },
  { path: '/rules', labelKey: 'nav.rules', section: 'nav.section.administration', icon: SlidersHorizontal, component: lazy(() => import('../pages/Rules')), help: 'allocation' },
  { path: '/settings', labelKey: 'nav.settings', section: 'nav.section.administration', icon: Settings, component: lazy(() => import('../pages/Settings')), help: 'start' },
  { path: '/help', labelKey: 'nav.help', section: 'nav.section.administration', icon: CircleHelp, component: lazy(() => import('../pages/HelpCenter')), help: 'start' },
  { path: '/cmdb-audit', labelKey: 'nav.cmdbAudit', section: 'nav.section.assetInventory', icon: History, component: lazy(() => import('../pages/CMDBAuditLog')), help: 'cmdb' },
  { path: '/recommendations/archived', labelKey: 'nav.recommendations', section: 'nav.section.overview', icon: Archive, component: lazy(() => import('../pages/Recommendations')), help: 'finops', navigation: false },
 ]

export const navigationSections = [
  'nav.section.overview', 'nav.section.costManagement', 'nav.section.resourceManagement',
  'nav.section.assetInventory', 'nav.section.governance', 'nav.section.administration',
].map((key) => ({ key, items: productRoutes.filter((route) => route.section === key && route.navigation !== false) }))

/** Match the most specific route, with a segment boundary (never /resources-other). */
export function routeForPath(pathname: string): ProductRoute | undefined {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  return productRoutes.filter((route) => path === route.path || path.startsWith(`${route.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
}
