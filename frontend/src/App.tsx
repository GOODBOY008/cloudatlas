import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { auth } from './lib/auth'
import ErrorBoundary from './components/ErrorBoundary'
import Layout from './components/Layout'
import Login from './pages/Login'

// Pages are lazy-loaded so each route ships in its own chunk.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Expenses = lazy(() => import('./pages/Expenses'))
const Pools = lazy(() => import('./pages/Pools'))
const CMDB = lazy(() => import('./pages/CMDB'))
const Recommendations = lazy(() => import('./pages/Recommendations'))
const CloudAccounts = lazy(() => import('./pages/CloudAccounts'))
const Settings = lazy(() => import('./pages/Settings'))
const Rules = lazy(() => import('./pages/Rules'))
const PowerSchedules = lazy(() => import('./pages/PowerSchedules'))
const Alerts = lazy(() => import('./pages/Alerts'))
const CostCenters = lazy(() => import('./pages/CostCenters'))
const Services = lazy(() => import('./pages/Services'))
const DynamicGroups = lazy(() => import('./pages/DynamicGroups'))
const Compliance = lazy(() => import('./pages/Compliance'))
const Showback = lazy(() => import('./pages/Showback'))
const TaggingCoverage = lazy(() => import('./pages/TaggingCoverage'))
const CostMap = lazy(() => import('./pages/CostMap'))
const Resources = lazy(() => import('./pages/Resources'))
const AnomalyDetection = lazy(() => import('./pages/AnomalyDetection'))
const QuotasBudgets = lazy(() => import('./pages/QuotasBudgets'))
const CostComparison = lazy(() => import('./pages/CostComparison'))
const Archive = lazy(() => import('./pages/Archive'))
const SharedEnvironments = lazy(() => import('./pages/SharedEnvironments'))
const ResourceLifecycle = lazy(() => import('./pages/ResourceLifecycle'))
const K8sRightsizing = lazy(() => import('./pages/K8sRightsizing'))
const CIClassifications = lazy(() => import('./pages/CIClassifications'))
const AssociationKinds = lazy(() => import('./pages/AssociationKinds'))
const ModelTopology = lazy(() => import('./pages/ModelTopology'))
const CMDBStats = lazy(() => import('./pages/CMDBStats'))
const ServiceTemplates = lazy(() => import('./pages/ServiceTemplates'))
const CIImport = lazy(() => import('./pages/CIImport'))
const FieldTemplates = lazy(() => import('./pages/FieldTemplates'))
const CITopology = lazy(() => import('./pages/CITopology'))
const CIApplyRules = lazy(() => import('./pages/CIApplyRules'))
const CMDBAuditLog = lazy(() => import('./pages/CMDBAuditLog'))
const Webhooks = lazy(() => import('./pages/Webhooks'))
const DriftDetection = lazy(() => import('./pages/DriftDetection'))
const CITypes = lazy(() => import('./pages/CITypes'))
const BillingImport = lazy(() => import('./pages/BillingImport'))
const AlertEvents = lazy(() => import('./pages/AlertEvents'))
const Checklist = lazy(() => import('./pages/Checklist'))
const ExternalCMDB = lazy(() => import('./pages/ExternalCMDB'))
const Constraints = lazy(() => import('./pages/Constraints'))
const Events = lazy(() => import('./pages/Events'))
const TaggingPolicies = lazy(() => import('./pages/TaggingPolicies'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const BIExport = lazy(() => import('./pages/BIExport'))
const Integrations = lazy(() => import('./pages/Integrations'))
const S3Duplicates = lazy(() => import('./pages/S3Duplicates'))
const AICenter = lazy(() => import('./pages/AICenter'))

function RequireAuth({ children }: { children: React.ReactNode }) {
  return auth.isAuthenticated() ? <>{children}</> : <Navigate to="/login" replace />
}

function RedirectIfAuth({ children }: { children: React.ReactNode }) {
  return auth.isAuthenticated() ? <Navigate to="/dashboard" replace /> : <>{children}</>
}

function PageFallback() {
  return <div className="p-6 text-gray-500 text-sm">Loading…</div>
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
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
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/showback" element={<Showback />} />
          <Route path="/tagging-coverage" element={<TaggingCoverage />} />
          <Route path="/cost-map" element={<CostMap />} />
          <Route path="/pools" element={<Pools />} />
          <Route path="/cmdb" element={<CMDB />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/recommendations/archived" element={<Recommendations />} />
          <Route path="/cloud-accounts" element={<CloudAccounts />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/schedules" element={<PowerSchedules />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/cost-centers" element={<CostCenters />} />
          <Route path="/services" element={<Services />} />
          <Route path="/dynamic-groups" element={<DynamicGroups />} />
          <Route path="/compliance" element={<Compliance />} />
          <Route path="/resources" element={<Resources />} />
          <Route path="/anomaly-detection" element={<AnomalyDetection />} />
          <Route path="/quotas-budgets" element={<QuotasBudgets />} />
          <Route path="/cost-comparison" element={<CostComparison />} />
          <Route path="/archive" element={<Archive />} />
          <Route path="/shared-environments" element={<SharedEnvironments />} />
          <Route path="/resource-lifecycle" element={<ResourceLifecycle />} />
          <Route path="/k8s-rightsizing" element={<K8sRightsizing />} />
          <Route path="/ci-classifications" element={<CIClassifications />} />
          <Route path="/association-kinds" element={<AssociationKinds />} />
          <Route path="/model-topology" element={<ModelTopology />} />
          <Route path="/cmdb-stats" element={<CMDBStats />} />
          <Route path="/service-templates" element={<ServiceTemplates />} />
          <Route path="/ci-import" element={<CIImport />} />
          <Route path="/field-templates" element={<FieldTemplates />} />
          <Route path="/ci-topology" element={<CITopology />} />
          <Route path="/ci-apply-rules" element={<CIApplyRules />} />
          <Route path="/cmdb-audit" element={<CMDBAuditLog />} />
          <Route path="/webhooks" element={<Webhooks />} />
          <Route path="/drift" element={<DriftDetection />} />
          <Route path="/ci-types" element={<CITypes />} />
          <Route path="/billing-import" element={<BillingImport />} />
          <Route path="/alert-events" element={<AlertEvents />} />
          <Route path="/checklist" element={<Checklist />} />
          <Route path="/external-cmdb" element={<ExternalCMDB />} />
          <Route path="/constraints" element={<Constraints />} />
          <Route path="/events" element={<Events />} />
          <Route path="/tagging-policies" element={<TaggingPolicies />} />
          <Route path="/bi-export" element={<BIExport />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/s3-duplicates" element={<S3Duplicates />} />
          <Route path="/ai-center" element={<AICenter />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  )
}
