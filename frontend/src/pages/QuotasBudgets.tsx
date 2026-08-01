import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface BudgetRow { pool_id: string | null; pool_name: string; pool_type: string; budget: number | null; actual: number; utilization_pct: number | null; status: string; variance: number | null }
interface Alert { id: string; name: string; threshold: number; alert_type: string; is_active: boolean; last_triggered_at: string | null }
interface Constraint { id: string; name: string; constraint_type: string; limit_value: number | null; is_active: boolean; last_triggered_at: string | null }

function fmt(v: number | null | undefined) { return v != null ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—' }

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const cls: Record<string, string> = {
    over_budget: 'bg-red-900 text-red-300',
    warning: 'bg-yellow-900 text-yellow-300',
    on_track: 'bg-green-900 text-green-300',
    no_budget: 'bg-gray-700 text-gray-400',
  }
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls[status] ?? 'bg-gray-700 text-gray-400'}`}>{t(`status.${status}`, { defaultValue: status.replace('_', ' ') })}</span>
}

export default function QuotasBudgets() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<'budgets' | 'alerts' | 'quotas'>('budgets')
  const [showAlertForm, setShowAlertForm] = useState(false)
  const [showQuotaForm, setShowQuotaForm] = useState(false)
  const [alertForm, setAlertForm] = useState({ name: '', threshold: '', alert_type: 'budget' })
  const [quotaForm, setQuotaForm] = useState({ name: '', constraint_type: 'total_expense', limit_value: '' })

  const { data: budgetMatrix } = useQuery({
    queryKey: ['budget-matrix', orgId],
    queryFn: () => api.get<{ data: BudgetRow[] }>(`/orgs/${orgId}/pools/budget-matrix`).then(r => { const d = r.data?.data; return Array.isArray(d) ? d : [] }),
    enabled: !!orgId,
  })

  const { data: alerts } = useQuery({
    queryKey: ['alerts', orgId],
    queryFn: () => api.get<{ data: Alert[] }>(`/orgs/${orgId}/alerts`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const { data: quotas } = useQuery({
    queryKey: ['constraints-quota', orgId],
    queryFn: () => api.get<{ data: Constraint[] }>(`/orgs/${orgId}/constraints`).then(r => (r.data.data ?? []).filter(c => c.constraint_type !== 'anomaly')),
    enabled: !!orgId,
  })

  const evaluateAlerts = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/alerts/evaluate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts', orgId] }),
  })

  const createAlert = useMutation({
    mutationFn: (body: unknown) => api.post(`/orgs/${orgId}/alerts`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alerts', orgId] }); setShowAlertForm(false) },
  })

  const createQuota = useMutation({
    mutationFn: (body: unknown) => api.post(`/orgs/${orgId}/constraints`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['constraints-quota', orgId] }); setShowQuotaForm(false) },
  })

  const deleteAlert = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/alerts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts', orgId] }),
  })

  const matrix = budgetMatrix ?? []
  const overBudget = matrix.filter(b => b.status === 'over_budget').length
  const warning = matrix.filter(b => b.status === 'warning').length
  const totalBudget = matrix.reduce((s, b) => s + (b.budget ?? 0), 0)
  const totalSpend = matrix.reduce((s, b) => s + (b.actual ?? 0), 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('quotas.title')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t('quotas.subtitle')}</p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => evaluateAlerts.mutate()} disabled={evaluateAlerts.isPending}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
            {t('quotas.evaluateAlerts')}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t('quotas.totalBudget'), value: fmt(totalBudget), color: 'text-indigo-300' },
          { label: t('quotas.totalSpend'), value: fmt(totalSpend), color: 'text-white' },
          { label: t('status.over_budget'), value: String(overBudget), color: 'text-red-400' },
          { label: t('status.warning'), value: String(warning), color: 'text-yellow-400' },
        ].map(c => (
          <div key={c.label} className="bg-gray-900 rounded-xl border border-gray-700 p-5">
            <p className="text-xs text-gray-400 uppercase tracking-wider">{c.label}</p>
            <p className={`text-2xl font-bold mt-1 ${c.color}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* Budget utilization chart */}
      {matrix.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <h2 className="text-sm font-semibold text-white mb-4">{t('quotas.budgetUtilizationByPool')}</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={matrix.slice(0, 10).map(b => ({ name: b.pool_name?.slice(0, 14), pct: Math.round(b.utilization_pct ?? ((b.budget ?? 0) > 0 ? (b.actual / (b.budget ?? 1)) * 100 : 0)), status: b.status }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#9CA3AF' }} />
              <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} unit="%" domain={[0, 120]} />
              <Tooltip formatter={(v: number) => `${v}%`} />
              <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
                {matrix.slice(0, 10).map((b, i) => (
                  <Cell key={i} fill={b.status === 'over_budget' ? '#ef4444' : b.status === 'warning' ? '#f59e0b' : '#10b981'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-700">
        {([
          { key: 'budgets', label: t('quotas.poolBudgetsCount', { count: matrix.length }) },
          { key: 'alerts', label: t('quotas.alertRulesCount', { count: (alerts ?? []).length }) },
          { key: 'quotas', label: t('quotas.quotasCount', { count: (quotas ?? []).length }) },
        ] as const).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key as any)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${activeTab === tab.key ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'budgets' && (
        <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-700">
              {[t('quotas.colPool'), t('quotas.colBudget'), t('quotas.colActualSpend'), t('quotas.colUtilization'), t('common.status')].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">{h}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              {matrix.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-500">{t('quotas.noPoolsWithBudgets')}</td></tr>
              ) : matrix.map((b, i) => {
                const pct = (b.budget ?? 0) > 0 ? Math.min((b.actual / (b.budget ?? 1)) * 100, 120) : 0
                const barColor = b.status === 'over_budget' ? 'bg-red-500' : b.status === 'warning' ? 'bg-yellow-500' : 'bg-green-500'
                return (
                  <tr key={i} className="hover:bg-gray-800">
                    <td className="px-4 py-3 font-medium text-white">{b.pool_name}</td>
                    <td className="px-4 py-3 text-gray-300">{(b.budget ?? 0) > 0 ? fmt(b.budget) : '—'}</td>
                    <td className="px-4 py-3 font-semibold text-white">{fmt(b.actual)}</td>
                    <td className="px-4 py-3 w-48">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-700 rounded-full h-2">
                          <div className={`h-2 rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="text-xs text-gray-300 w-12 text-right">{pct.toFixed(0)}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={b.status} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'alerts' && (
        <>
          <div className="flex justify-end">
            <button onClick={() => setShowAlertForm(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">{t('quotas.addAlertRule')}</button>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-700">
                {[t('common.name'), t('common.type'), t('quotas.colThreshold'), t('common.status'), t('quotas.colLastTriggered'), t('common.actions')].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr></thead>
              <tbody className="divide-y divide-gray-800">
                {(alerts ?? []).length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">{t('quotas.noAlertRules')}</td></tr>
                ) : (alerts ?? []).map(a => (
                  <tr key={a.id} className="hover:bg-gray-800">
                    <td className="px-4 py-3 font-medium text-white">{a.name}</td>
                    <td className="px-4 py-3"><span className="px-2 py-0.5 bg-indigo-900 text-indigo-300 rounded text-xs">{t(`status.${a.alert_type}`, { defaultValue: a.alert_type })}</span></td>
                    <td className="px-4 py-3 text-gray-300">{fmt(a.threshold)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${a.is_active ? 'bg-green-900 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
                        {a.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{a.last_triggered_at ? a.last_triggered_at.slice(0, 16) : t('common.never')}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => deleteAlert.mutate(a.id)} className="text-red-400 hover:text-red-300 text-xs">{t('common.delete')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'quotas' && (
        <>
          <div className="flex justify-end">
            <button onClick={() => setShowQuotaForm(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">{t('quotas.addQuota')}</button>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-700">
                {[t('common.name'), t('common.type'), t('quotas.colLimit'), t('common.status'), t('quotas.colLastTriggered')].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr></thead>
              <tbody className="divide-y divide-gray-800">
                {(quotas ?? []).length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-500">{t('quotas.noQuotaConstraints')}</td></tr>
                ) : (quotas ?? []).map(q => (
                  <tr key={q.id} className="hover:bg-gray-800">
                    <td className="px-4 py-3 font-medium text-white">{q.name}</td>
                    <td className="px-4 py-3"><span className="px-2 py-0.5 bg-purple-900 text-purple-300 rounded text-xs">{t(`status.${q.constraint_type}`, { defaultValue: q.constraint_type })}</span></td>
                    <td className="px-4 py-3 text-gray-300">{q.limit_value != null ? fmt(q.limit_value) : '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${q.is_active ? 'bg-green-900 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
                        {q.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{q.last_triggered_at ? q.last_triggered_at.slice(0, 16) : t('common.never')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Alert form modal */}
      {showAlertForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowAlertForm(false)} />
          <div className="relative bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">{t('quotas.newAlertRule')}</h3>
            {[
              { label: t('common.name'), field: 'name', type: 'text' },
              { label: t('quotas.thresholdAmount'), field: 'threshold', type: 'number' },
            ].map(({ label, field, type }) => (
              <div key={field}>
                <label className="text-xs text-gray-400 mb-1 block">{label}</label>
                <input type={type} value={(alertForm as any)[field]} onChange={e => setAlertForm(f => ({ ...f, [field]: e.target.value }))}
                  className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 focus:outline-none focus:border-indigo-500" />
              </div>
            ))}
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowAlertForm(false)} className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg">{t('common.cancel')}</button>
              <button onClick={() => createAlert.mutate({ name: alertForm.name, threshold: parseFloat(alertForm.threshold), alert_type: 'budget' })}
                disabled={!alertForm.name || !alertForm.threshold || createAlert.isPending}
                className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg disabled:opacity-50">
                {t('quotas.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quota form modal */}
      {showQuotaForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowQuotaForm(false)} />
          <div className="relative bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">{t('quotas.newQuota')}</h3>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">{t('common.name')}</label>
              <input value={quotaForm.name} onChange={e => setQuotaForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">{t('common.type')}</label>
              <select value={quotaForm.constraint_type} onChange={e => setQuotaForm(f => ({ ...f, constraint_type: e.target.value }))}
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700">
                <option value="total_expense">{t('quotas.typeTotalExpense')}</option>
                <option value="resource_count">{t('quotas.typeResourceCount')}</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">{t('quotas.limitValue')}</label>
              <input type="number" value={quotaForm.limit_value} onChange={e => setQuotaForm(f => ({ ...f, limit_value: e.target.value }))}
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 focus:outline-none focus:border-indigo-500" />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowQuotaForm(false)} className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg">{t('common.cancel')}</button>
              <button onClick={() => createQuota.mutate({ name: quotaForm.name, constraint_type: quotaForm.constraint_type, limit_value: parseFloat(quotaForm.limit_value) })}
                disabled={!quotaForm.name || !quotaForm.limit_value || createQuota.isPending}
                className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg disabled:opacity-50">
                {t('quotas.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
