import { NativeDialog } from '../components/shared/NativeDialog'
import { chartColors, chartAxis, chartGrid } from '../lib/chartTheme'
import { useMoneyFormatter } from '../lib/format'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface Constraint {
  id: string
  name: string
  constraint_type: string
  filters: Record<string, unknown>
  limit_value: number | null
  is_active: boolean
  last_triggered_at: string | null
  created_at: string
}

interface Anomaly {
  date: string
  cloud_resource_id: string
  resource_name: string | null
  resource_type: string
  cost: number
  mean_cost: number
  z_score: number
  deviation_pct: number
}


const TYPES = ['anomaly', 'resource_count', 'total_expense']

export default function AnomalyDetection() {
  const fmt = useMoneyFormatter()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const qc = useQueryClient()
  const { t } = useTranslation()

  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', constraint_type: 'anomaly', limit_value: '' })
  const [activeTab, setActiveTab] = useState<'policies' | 'violations'>('violations')

  const { data: constraints, isLoading: cLoading } = useQuery({
    queryKey: ['constraints', orgId],
    queryFn: () => api.get<{ data: Constraint[] }>(`/orgs/${orgId}/constraints`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const { data: anomalies, isLoading: aLoading } = useQuery({
    queryKey: ['anomalies', orgId],
    queryFn: () => api.get<{ data: Anomaly[] }>(`/orgs/${orgId}/expenses/anomalies`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const evaluate = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/constraints/evaluate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['constraints', orgId] }),
  })

  const createConstraint = useMutation({
    mutationFn: (body: unknown) => api.post(`/orgs/${orgId}/constraints`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['constraints', orgId] }); setShowCreate(false); setForm({ name: '', constraint_type: 'anomaly', limit_value: '' }) },
  })

  const deleteConstraint = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/constraints/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['constraints', orgId] }),
  })

  // Cost impact of anomalies
  const totalAnomalyCost = (anomalies ?? []).reduce((s, a) => s + (a.cost - a.mean_cost), 0)
  const topAnomalies = (anomalies ?? []).sort((a, b) => b.deviation_pct - a.deviation_pct).slice(0, 8)

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('anomalyDetection.title')}</h1>
          <p className="text-sm text-secondary mt-1">{t('anomalyDetection.subtitle')}</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => evaluate.mutate()}
            disabled={evaluate.isPending}
            className="px-4 py-2 bg-warning-solid hover:bg-warning-solid/90 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {evaluate.isPending ? t('anomalyDetection.evaluating') : t('anomalyDetection.runEvaluate')}
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="btn-primary"
          >
            {t('anomalyDetection.addPolicy')}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('anomalyDetection.totalAnomalies')}</p>
          <p className="text-2xl font-semibold text-warning mt-1">{(anomalies ?? []).length}</p>
          <p className="text-xs text-muted mt-1">{t('anomalyDetection.thisPeriod')}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('anomalyDetection.costImpact')}</p>
          <p className="text-2xl font-semibold text-danger mt-1">{fmt(totalAnomalyCost)}</p>
          <p className="text-xs text-muted mt-1">{t('anomalyDetection.aboveBaseline')}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('anomalyDetection.activePolicies')}</p>
          <p className="text-2xl font-semibold text-accent mt-1">{(constraints ?? []).filter(c => c.is_active).length}</p>
          <p className="text-xs text-muted mt-1">{t('anomalyDetection.ofTotal', { count: (constraints ?? []).length })}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="page-tabs ">
        {(['violations', 'policies'] as const).map(tab => (
          <button aria-pressed={activeTab === tab}
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="page-tab"
          >
            {tab === 'violations' ? t('anomalyDetection.tabAnomalies', { count: (anomalies ?? []).length }) : t('anomalyDetection.tabPolicies', { count: (constraints ?? []).length })}
          </button>
        ))}
      </div>

      {activeTab === 'violations' && (
        <div className="space-y-4">
          {/* Chart */}
          {topAnomalies.length > 0 && (
            <div className="bg-surface rounded-xl border border-strong p-5">
              <p className="text-sm font-semibold text-primary mb-3">{t('anomalyDetection.topAnomaliesByDeviation')}</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={topAnomalies.map(a => ({ name: (a.resource_name ?? a.cloud_resource_id).slice(0, 16), deviation: Math.round(a.deviation_pct) }))}>
                  <CartesianGrid {...chartGrid}  vertical={false} />
                  <XAxis {...chartAxis} dataKey="name" tick={{ fontSize: 10, fill: 'rgb(var(--text-muted))' }} />
                  <YAxis {...chartAxis} tick={{ fontSize: 10, fill: 'rgb(var(--text-muted))' }} unit="%" />
                  <Tooltip formatter={(v: number) => `${v}%`} />
                  <Bar isAnimationActive={false} maxBarSize={32} dataKey="deviation" radius={[4, 4, 0, 0]}>
                    {topAnomalies.map((_, i) => <Cell key={i} fill={i < 3 ? chartColors.danger : chartColors.orange} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Anomalies table */}
          <div className="bg-surface rounded-xl border border-strong overflow-hidden">
            <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-strong">
                  {['anomalyDetection.colResource', 'common.type', 'anomalyDetection.colDate', 'anomalyDetection.colCost', 'anomalyDetection.colBaseline', 'anomalyDetection.colDeviation', 'anomalyDetection.colZScore'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wider">{t(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {aLoading ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-muted">{t('common.loading')}</td></tr>
                ) : (anomalies ?? []).length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-muted">{t('anomalyDetection.noAnomalies')}</td></tr>
                ) : (anomalies ?? []).map((a, i) => (
                  <tr key={i} className="hover:bg-subtle">
                    <td className="px-4 py-3">
                      <div className="font-medium text-primary">{a.resource_name ?? a.cloud_resource_id.slice(0, 20)}</div>
                      <div className="text-xs text-muted">{a.date?.slice(0, 10)}</div>
                    </td>
                    <td className="px-4 py-3 text-secondary">{t(`resType.${a.resource_type}`, { defaultValue: a.resource_type })}</td>
                    <td className="px-4 py-3 text-secondary">{a.date?.slice(0, 10)}</td>
                    <td className="px-4 py-3 font-semibold text-danger">{fmt(a.cost)}</td>
                    <td className="px-4 py-3 text-secondary">{fmt(a.mean_cost)}</td>
                    <td className="px-4 py-3">
                      <span className={`font-semibold ${a.deviation_pct > 100 ? 'text-danger' : 'text-warning'}`}>
                        +{a.deviation_pct.toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-secondary">{a.z_score.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </div>
      )}

      {activeTab === 'policies' && (
        <div className="bg-surface rounded-xl border border-strong overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-strong">
                {['anomalyDetection.colPolicyName', 'common.type', 'anomalyDetection.colLimit', 'common.status', 'anomalyDetection.colLastTriggered', 'common.actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wider">{t(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {cLoading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-muted">{t('common.loading')}</td></tr>
              ) : (constraints ?? []).length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-muted">{t('anomalyDetection.noPolicies')}</td></tr>
              ) : (constraints ?? []).map(c => (
                <tr key={c.id} className="hover:bg-subtle">
                  <td className="px-4 py-3 font-medium text-primary">{c.name}</td>
                  <td className="px-4 py-3"><span className="px-2 py-0.5 bg-accent-soft text-accent rounded text-xs">{t(`anomalyDetection.constraintType.${c.constraint_type}`, { defaultValue: c.constraint_type })}</span></td>
                  <td className="px-4 py-3 text-secondary">{c.limit_value != null ? fmt(c.limit_value) : '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.is_active ? 'bg-success/10 text-success' : 'bg-emphasis text-secondary'}`}>
                      {c.is_active ? t('common.active') : t('common.inactive')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-secondary text-xs">{c.last_triggered_at ? c.last_triggered_at.slice(0, 16) : t('common.never')}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => deleteConstraint.mutate(c.id)} className="text-danger hover:text-danger text-xs">{t('common.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <NativeDialog className="items-center justify-center p-4" label={t('anomalyDetection.newPolicy')} onClose={() => setShowCreate(false)}>

          <div className="dialog-panel relative p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-primary">{t('anomalyDetection.newPolicy')}</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-secondary mb-1 block">{t('common.name')}</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full bg-subtle text-primary px-3 py-2 rounded-lg text-sm border border-strong focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-xs text-secondary mb-1 block">{t('common.type')}</label>
                <select value={form.constraint_type} onChange={e => setForm(f => ({ ...f, constraint_type: e.target.value }))}
                  className="w-full bg-subtle text-primary px-3 py-2 rounded-lg text-sm border border-strong">
                  {TYPES.map(type => <option key={type} value={type}>{t(`anomalyDetection.constraintType.${type}`, { defaultValue: type })}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-secondary mb-1 block">{t('anomalyDetection.limitValue')}</label>
                <input type="number" value={form.limit_value} onChange={e => setForm(f => ({ ...f, limit_value: e.target.value }))}
                  className="w-full bg-subtle text-primary px-3 py-2 rounded-lg text-sm border border-strong focus:outline-none focus:border-accent" />
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowCreate(false)} className="btn-secondary flex-1">{t('common.cancel')}</button>
              <button
                onClick={() => createConstraint.mutate({ name: form.name, constraint_type: form.constraint_type, limit_value: form.limit_value ? parseFloat(form.limit_value) : null })}
                disabled={!form.name || createConstraint.isPending}
                className="btn-primary flex-1"
              >
                {t('anomalyDetection.create')}
              </button>
            </div>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
