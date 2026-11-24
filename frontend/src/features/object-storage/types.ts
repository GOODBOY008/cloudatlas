import { isAxiosError } from 'axios'
import type { PageMeta } from '../../types'

export interface Period {
  start_date: string
  end_date: string
}
export interface Owner {
  service_id: string
  service_name: string
  system_name: string | null
  team_name: string | null
  deployment_id: string
  deployment_name: string
  is_default: boolean
}
export interface Bucket {
  id: string
  ci_id: string | null
  name: string
  cloud_resource_id: string
  cloud_account_id: string
  account_name: string
  provider: string
  region: string | null
  last_seen: string
  tags: Record<string, string>
  owners: Owner[]
  cost: number | null
}
export interface Overview {
  bucket_count: number
  unclaimed_count: number
  billed_count: number
  period_cost: number | null
  allocated_cost: number | null
  unallocated_cost: number | null
  excluded_currency_rows: number
  currency: string
  accounts: { id: string; name: string }[]
  allocation: { cloud_account_id: string; account_name: string; kind: string; cost: number }[]
  buckets: Bucket[]
  can_bind: boolean
  can_import: boolean
  can_allocate: boolean
}
export interface Inventory {
  id: string
  captured_at: string
  created_at: string
  status: string
  error: string | null
  prefix: string
  source: string
  object_count: number | null
  size_bytes: number | null
  rate_class: string | null
  rate_gib_month: number | null
  rate_currency: string | null
  rate_source: string | null
}
export interface Detail extends Bucket {
  rules: { effective_from: string; weights: Record<string, number> }[]
  service_costs: { service_id: string; service_name: string; cost: number }[]
  environment: string
  usage: {
    object_count: number | null
    size_bytes: number | null
    covered_objects: number | null
    covered_bytes: number | null
    full_at: string | null
    latest_at: string | null
  }
  trend: { date: string; cost: number }[]
  breakdown: { category: string; cost: number }[]
  imports: Inventory[]
}
export interface Bill {
  expense_id: string
  seq: number | null
  raw_id: string | null
  imported_at: string | null
  account_name: string
  cloud_resource_id: string
  date: string
  cost: number
  currency: string
  original_cost: string | null
  original_currency: string | null
  category: string
  service: string | null
  item: string | null
  allocation: string
}
export interface Copy {
  bucket_id: string
  bucket_name: string
  object_key: string
  version_id: string
  storage_class: string | null
  captured_at: string
  import_id: string
  prefix: string
  services: string[]
  rate_source: string | null
  rate_gib_month: number | null
  rate_class: string | null
  rate_currency: string | null
}
export interface Opportunity {
  gid: string
  kind: string
  val: string
  bytes: number
  copies: number
  potential_bytes: number | null
  potential_monthly: number | null
  members: Copy[]
}
export interface Findings {
  groups: Opportunity[]
  names: { id: string; name: string; region: string | null; account_name: string; similarity: number }[]
  currency: string
}
export interface Envelope<T> {
  data: T
  meta: PageMeta
}
export function failure(error: unknown, fallback: string) {
  if (isAxiosError(error))
    return error.response?.data?.error?.message || error.response?.data?.message || fallback
  return fallback
}
export function bytes(value: number | null): string {
  if (value === null) return '—'
  if (value === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const index = Math.min(Math.floor(Math.log2(value) / 10), units.length - 1)
  return `${Number((value / 1024 ** index).toFixed(2))} ${units[index]}`
}
