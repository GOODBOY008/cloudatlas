import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

// T14: daily trend point from /orgs/{id}/cmdb/stats/trends.
interface TrendPoint {
  date: string
  total_cis: number
  change_count: number
}

// Field names match the actual /orgs/{id}/cmdb/stats response shape.
// (Previously the interface assumed a different contract; this was a pre-existing
// data-shape mismatch that surfaced after the sidebar redesign moved this page
// into the Asset Inventory section. See error: "Cannot read properties of
// undefined (reading 'total')" on the legacy `compliance_summary.total` access.)
interface CMDBStats {
  total_cis: number
  total_services: number
  total_dynamic_groups?: number
  recent_changes_7d: number
  open_drift: number
  lifecycle_distribution: { state?: string; lifecycle_state?: string; count: number }[]
  type_distribution: {
    type_name?: string
    ci_type_name?: string
    type_display?: string
    ci_type_display?: string
    count: number
  }[]
  compliance: {
    active_policies?: number
    non_compliant_cis?: number
    total?: number
    compliant?: number
    non_compliant?: number
    drift?: number
  }
  recent_audit: {
    id: string
    ci_id?: string
    ci_name: string
    ci_type_name?: string
    operation: string
    user_email?: string
    created_at: string
  }[]
}

const LIFECYCLE_COLORS: Record<string, string> = {
  active: '#22c55e',
  stopped: '#f59e0b',
  terminated: '#ef4444',
  unknown: '#64748b',
}

const OPERATION_COLORS: Record<string, string> = {
  create: 'bg-green-900/40 text-green-300',
  update: 'bg-blue-900/40 text-blue-300',
  delete: 'bg-red-900/40 text-red-300',
  drift: 'bg-yellow-900/40 text-yellow-300',
  compliance_check: 'bg-purple-900/40 text-purple-300',
}

function StatCard({ label, value, sub, color = 'text-white' }: {
  label: string; value: number | string; sub?: string; color?: string
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

function formatDate(ts: string) {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

export default function CMDBStats() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const { data: stats, isLoading, isError } = useQuery<CMDBStats>({
    queryKey: ['cmdb-stats', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CMDBStats }>(
        `/orgs/${orgId}/cmdb/stats`
      )
      return res.data
    },
    refetchInterval: 60_000,
  })

  const { data: trends } = useQuery<{ days: number; points: TrendPoint[] }>({
    queryKey: ['cmdb-stats-trends', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { days: number; points: TrendPoint[] } }>(
        `/orgs/${orgId}/cmdb/stats/trends?days=30`,
      )
      return res.data
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500 text-sm">{t('cmdbStats.loading')}</p>
      </div>
    )
  }

  if (isError || !stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-red-400 text-sm">{t('cmdbStats.loadFailed')}</p>
      </div>
    )
  }

  // Compute compliance % from whichever fields the API actually returned.
  // New contract: compliance.active_policies + compliance.non_compliant_cis
  // Legacy contract: compliance_summary.{total, compliant, non_compliant, drift}
  const complianceTotal =
    stats.compliance.total ?? stats.compliance.active_policies ?? 0
  const complianceCompliant =
    stats.compliance.compliant ??
    Math.max(0, (stats.compliance.active_policies ?? 0) - (stats.compliance.non_compliant_cis ?? 0))
  const complianceNonCompliant =
    stats.compliance.non_compliant ?? stats.compliance.non_compliant_cis ?? 0
  const complianceDrift = stats.compliance.drift ?? stats.open_drift ?? 0
  const compliancePct =
    complianceTotal > 0 ? Math.round((complianceCompliant / complianceTotal) * 100) : 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">{t('cmdbStats.title')}</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {t('cmdbStats.subtitle')}
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label={t('cmdbStats.totalCis')} value={stats.total_cis.toLocaleString()} color="text-indigo-400" />
        <StatCard label={t('cmdbStats.totalServices')} value={stats.total_services.toLocaleString()} color="text-blue-400" />
        <StatCard
          label={t('cmdbStats.changes7d')}
          value={stats.recent_changes_7d.toLocaleString()}
          color={stats.recent_changes_7d > 50 ? 'text-yellow-400' : 'text-white'}
        />
        <StatCard
          label={t('cmdbStats.openDrift')}
          value={stats.open_drift.toLocaleString()}
          color={stats.open_drift > 0 ? 'text-red-400' : 'text-green-400'}
          sub={stats.open_drift > 0 ? t('cmdbStats.requiresAttention') : t('cmdbStats.allSynced')}
        />
      </div>

      {/* Compliance card */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white">{t('cmdbStats.complianceOverview')}</h2>
          <span className={`text-lg font-bold ${compliancePct >= 80 ? 'text-green-400' : compliancePct >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
            {compliancePct}%
          </span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
          <div
            className={`h-3 rounded-full transition-all duration-500 ${compliancePct >= 80 ? 'bg-green-500' : compliancePct >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
            style={{ width: `${compliancePct}%` }}
          />
        </div>
        <div className="flex gap-6 mt-3 flex-wrap">
          <span className="text-xs text-gray-500">{t('cmdbStats.policies', { count: complianceTotal })}</span>
          <span className="text-xs text-gray-500">{t('cmdbStats.compliant', { count: complianceCompliant })}</span>
          <span className="text-xs text-gray-500">{t('cmdbStats.nonCompliant', { count: complianceNonCompliant })}</span>
          <span className="text-xs text-gray-500">{t('cmdbStats.drift', { count: complianceDrift })}</span>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Lifecycle Distribution */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-semibold text-white mb-4">{t('cmdbStats.lifecycleDistribution')}</h2>
          {stats.lifecycle_distribution.length === 0 ? (
            <p className="text-gray-600 text-sm text-center py-8">{t('cmdbStats.noData')}</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stats.lifecycle_distribution} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="state"
                  tick={{ fill: '#9ca3af', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => t(`lifecycle.${v}`, { defaultValue: v })}
                />
                <YAxis
                  tick={{ fill: '#9ca3af', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
                  labelStyle={{ color: '#fff' }}
                  itemStyle={{ color: '#d1d5db' }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {stats.lifecycle_distribution.map((entry, idx) => (
                    <Cell
                      key={`lc-${idx}`}
                      fill={LIFECYCLE_COLORS[entry.state ?? entry.lifecycle_state ?? 'unknown'] ?? '#6366f1'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* CI Type Distribution */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-semibold text-white mb-4">{t('cmdbStats.ciTypeDistribution')}</h2>
          {stats.type_distribution.length === 0 ? (
            <p className="text-gray-600 text-sm text-center py-8">{t('cmdbStats.noData')}</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={stats.type_distribution}
                layout="vertical"
                barCategoryGap="20%"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: '#9ca3af', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="type_display"
                  tick={{ fill: '#9ca3af', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={90}
                />
                <Tooltip
                  contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
                  labelStyle={{ color: '#fff' }}
                  itemStyle={{ color: '#d1d5db' }}
                />
                <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Recent Audit Events */}
      <div className="bg-gray-900 rounded-xl border border-gray-800">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">{t('cmdbStats.recentActivity')}</h2>
        </div>
        {stats.recent_audit.length === 0 ? (
          <p className="text-gray-600 text-sm text-center py-8">{t('cmdbStats.noRecentActivity')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-800">
                <th className="text-left px-4 py-2">{t('cmdb.colCi')}</th>
                <th className="text-left px-4 py-2">{t('cmdb.colType')}</th>
                <th className="text-left px-4 py-2">{t('cmdbStats.colOperation')}</th>
                <th className="text-left px-4 py-2">{t('cmdbStats.colUser')}</th>
                <th className="text-right px-4 py-2">{t('cmdbStats.colTime')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.recent_audit.map(entry => (
                <tr key={entry.id} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                  <td className="px-4 py-2 text-white">{entry.ci_name}</td>
                  <td className="px-4 py-2 text-gray-400 text-xs">{entry.ci_type_name ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${OPERATION_COLORS[entry.operation] ?? 'bg-gray-700 text-gray-400'}`}>
                      {t(`cmdbAuditLog.op.${entry.operation}`, { defaultValue: entry.operation })}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-400 text-xs">{entry.user_email ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-gray-500 text-xs">{formatDate(entry.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      {/* Trends (T14) */}
      {trends && trends.points.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4" data-testid="cmdb-stats-trend-total">
            <h3 className="text-sm font-semibold text-white mb-3">{t('cmdbStats.trendTotal')}</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trends.points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" stroke="#6b7280" fontSize={11} />
                  <YAxis stroke="#6b7280" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem' }}
                    labelStyle={{ color: '#9ca3af' }}
                  />
                  <Line type="monotone" dataKey="total_cis" name={t('cmdbStats.totalCis')} stroke="#818cf8" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4" data-testid="cmdb-stats-trend-changes">
            <h3 className="text-sm font-semibold text-white mb-3">{t('cmdbStats.trendChanges')}</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trends.points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" stroke="#6b7280" fontSize={11} />
                  <YAxis stroke="#6b7280" fontSize={11} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem' }}
                    labelStyle={{ color: '#9ca3af' }}
                  />
                  <Line type="monotone" dataKey="change_count" name={t('cmdbStats.changesDaily')} stroke="#34d399" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
