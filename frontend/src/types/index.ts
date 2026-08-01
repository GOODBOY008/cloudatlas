export interface User {
  id: string
  email: string
  display_name: string
}

// ─── Pagination (unified {data, meta} list envelope) ─────────────────────────

export interface PageMeta {
  total: number
  page: number
  per_page: number
  total_pages: number
}

export interface Paginated<T> {
  data: T[]
  meta: PageMeta
}

export interface PageParams {
  page?: number
  per_page?: number
}

export interface Organization {
  id: string
  name: string
  slug: string
}

export interface CloudAccount {
  id: string
  name: string
  provider: string
  is_active: boolean
  currency: string
  resource_count: number
  has_credentials: boolean
  last_sync_at: string | null
  config?: Record<string, unknown>
}

export interface Expense {
  id: string
  date: string
  cloud_resource_id: string
  resource_name: string
  service_name: string
  cost: number
  currency: string
  cloud_region: string
}

export interface Pool {
  id: string
  name: string
  description: string | null
  pool_type: string
  parent_id: string | null
  owner_id: string | null
  monthly_budget: number | null
  created_at: string
  updated_at: string
}

export interface CI {
  id: string
  name: string
  display_name: string
  lifecycle_state: string
  cloud_provider: string
  cloud_region: string
  ci_type_id?: string
  parent_ci_id?: string | null
  meta: Record<string, unknown>
  tags: Record<string, string>
}

export interface Recommendation {
  id: string
  title: string
  description: string
  rec_type: string
  status: string
  potential_savings: number
  current_monthly_cost: number
  savings_percent?: number | null
  cloud_resource_id?: string
  cloud_account_id?: string | null
  ci_id?: string | null
  details?: Record<string, unknown>
  dismissed_at?: string | null
  dismiss_reason?: string | null
  created_at?: string
  updated_at?: string
}

export interface DashboardSummary {
  total_cost: number
  resource_count: number
  active_recommendations: number
  pool_count: number
}

export interface AuthResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  user: User
}

/** All backend responses are wrapped in { data: T } */
export interface ApiResponse<T> {
  data: T
}

export interface ApiError {
  message: string
  code?: string
}

export interface RuleCondition {
  condition_type: string
  key: string | null
  value: string
}

export interface Rule {
  id: string
  name: string
  priority: number
  pool_id: string
  pool_name?: string
  is_active: boolean
  logic_operator: 'AND' | 'OR'
  conditions: RuleCondition[]
  created_at: number
}

export interface PowerSchedule {
  id: string
  name: string
  timezone: string
  resource_filter: string
  is_active: boolean
  created_at: number
}

export interface PowerScheduleTrigger {
  id: string
  schedule_id: string
  cron_expression: string
  action: 'start' | 'stop'
  created_at: string
  last_run_at?: string | null
  next_run_at?: string | null
}

export interface BudgetAlert {
  id: string
  organization_id: string
  pool_id: string | null
  pool_name?: string
  alert_type: 'ABSOLUTE' | 'PERCENTAGE'
  threshold: number
  description: string | null
  is_active: boolean
  created_at: number
}

export interface AlertEvaluationEvent {
  event_id: string
  alert_id: string
  budget_id: string
  pool_id: string | null
  alert_type: string
  threshold: number
  actual: number
  message: string
}

export interface AlertEvaluationSummary {
  evaluated: number
  triggered: number
  events: AlertEvaluationEvent[]
}

export interface ShowbackPoolBucket {
  pool_id: string | null
  pool_name: string
  pool_description: string | null
  cost: number
  resource_count: number
  allocation_pct: number
}

export interface ShowbackCostCenterBucket {
  cost_center_id: string | null
  cost_center_name: string
  cost_center_code: string
  cost: number
  resource_count: number
  allocation_pct: number
}

export interface ShowbackReport {
  period_days: number
  total_cost: number
  currency: string
  unallocated_cost: number
  unallocated_pct: number
  by_pool: ShowbackPoolBucket[]
  by_cost_center: ShowbackCostCenterBucket[]
}

export interface TagCoveragePolicy {
  policy_id: string
  policy_name: string
  description: string | null
  required_tags: string[]
  total_resources: number
  compliant_resources: number
  coverage_percent: number
  uncovered_resources: number
  uncovered_cost: number
}

export interface TagCoverageResponse {
  data: TagCoveragePolicy[]
  meta: {
    total_resources: number
    active_policies: number
  }
}

export interface CostCenter {
  id: string
  organization_id: string
  name: string
  code: string
  description: string | null
  parent_id: string | null
  owner: string | null
  current_cost?: number
  children?: CostCenter[]
  created_at: number
}

export interface Webhook {
  id: string
  name: string
  url: string
  events: string[]
  is_active: boolean
  channel?: string
  last_triggered_at: string | null
  last_status: number | null
  created_at: string
}

export interface WebhookEvent {
  id: string
  webhook_id: string
  webhook_name: string
  event_type: string
  payload: Record<string, unknown>
  status: string
  attempts: number
  response_status: number | null
  created_at: string
  delivered_at: string | null
}

export interface DriftRecord {
  id: string
  ci_id: string
  ci_name: string
  baseline_id: string
  field_path: string
  old_value: unknown
  new_value: unknown
  detected_at: string
  acknowledged_at: string | null
}

export interface CIBaseline {
  id: string
  ci_id: string
  ci_name: string
  label: string | null
  snapshot: Record<string, unknown>
  created_at: string
}

export interface CiType {
  id: string
  organization_id: string | null
  classification_id: string | null
  name: string
  display_name: string
  description: string | null
  icon: string | null
  cloud_provider: string | null
  is_builtin: boolean
  is_abstract: boolean
  parent_type_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface CiAttribute {
  id: string
  ci_type_id: string
  name: string
  display_name: string
  description: string | null
  attribute_type: string
  is_required: boolean
  is_unique: boolean
  default_value: string | null
  enum_values: unknown
  sort_order: number
  is_builtin: boolean
  created_at: string
}

export interface CiClassification {
  id: string
  organization_id: string | null
  name: string
  display_name: string
  description: string | null
  icon: string | null
  sort_order: number
  is_builtin: boolean
  ci_type_count: number
  created_at: string
  updated_at: string
}

// ─── Async jobs (spec 2026-09-09-async-jobs-design §5.1) ─────────────────────

export type JobKind = 'discovery' | 'billing_import'

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** A row of the generalized `sync_jobs` table (job JSON documented in §4.3). */
export interface AccountJob {
  id: string
  organization_id: string
  cloud_account_id: string
  account_name: string | null
  job_kind: JobKind | string
  status: JobStatus | string
  phase: string | null
  progress_current: number | null
  progress_total: number | null
  params: Record<string, unknown>
  result: {
    provider?: string
    raw_rows_inserted?: number
    days_imported?: number
    [key: string]: unknown
  }
  resources_discovered: number | null
  resources_created: number | null
  resources_updated: number | null
  resources_deleted: number | null
  error_message: string | null
  triggered_by: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

export const JOB_TERMINAL_STATUSES: JobStatus[] = ['succeeded', 'failed', 'cancelled']

export function isJobTerminal(job: { status: string }): boolean {
  return JOB_TERMINAL_STATUSES.includes(job.status as JobStatus)
}
