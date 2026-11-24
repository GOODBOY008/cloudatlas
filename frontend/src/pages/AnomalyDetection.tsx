import { PageTabs } from '../components/shared/PageTabs'
import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
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
          <Button
            variant="primary"
            onClick={() => evaluate.mutate()}
            disabled={evaluate.isPending}
          >
            {evaluate.isPending ? t('anomalyDetection.evaluating') : t('anomalyDetection.runEvaluate')}
          </Button>
          <Button
            variant="primary"
            onClick={() => setShowCreate(true)}
          >
            {t('anomalyDetection.addPolicy')}
          </Button>
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
      <PageTabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mb-5"
        tabs={(['violations', 'policies'] as const).map(tab => ({ value: tab, label: tab === 'violations' ? t('anomalyDetection.tabAnomalies', { count: (anomalies ?? []).length }) : t('anomalyDetection.tabPolicies', { count: (constraints ?? []).length }) }))}
      />

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
            <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
              <Table.Header variant="compact">
                <Table.Row className="border-b border-strong">
                  {['anomalyDetection.colResource', 'common.type', 'anomalyDetection.colDate', 'anomalyDetection.colCost', 'anomalyDetection.colBaseline', 'anomalyDetection.colDeviation', 'anomalyDetection.colZScore'].map(h => (
                    <Table.Head key={h} className="px-4 py-3 text-left">{t(h)}</Table.Head>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body className="divide-y divide-edge">
                {aLoading ? (
                  <Table.Row><Table.Cell colSpan={7} className="px-4 py-10 text-center text-muted">{t('common.loading')}</Table.Cell></Table.Row>
                ) : (anomalies ?? []).length === 0 ? (
                  <Table.Row><Table.Cell colSpan={7} className="px-4 py-10 text-center text-muted">{t('anomalyDetection.noAnomalies')}</Table.Cell></Table.Row>
                ) : (anomalies ?? []).map((a, i) => (
                  <Table.Row key={i} className="hover:bg-subtle">
                    <Table.Cell className="px-4 py-3">
                      <div className="font-medium text-primary">{a.resource_name ?? a.cloud_resource_id.slice(0, 20)}</div>
                      <div className="text-xs text-muted">{a.date?.slice(0, 10)}</div>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary">{t(`resType.${a.resource_type}`, { defaultValue: a.resource_type })}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary">{a.date?.slice(0, 10)}</Table.Cell>
                    <Table.Cell className="px-4 py-3 font-semibold text-danger">{fmt(a.cost)}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary">{fmt(a.mean_cost)}</Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      <span className={`font-semibold ${a.deviation_pct > 100 ? 'text-danger' : 'text-warning'}`}>
                        +{a.deviation_pct.toFixed(0)}%
                      </span>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary">{a.z_score.toFixed(2)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table></div>
          </div>
        </div>
      )}

      {activeTab === 'policies' && (
        <div className="bg-surface rounded-xl border border-strong overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact">
              <Table.Row className="border-b border-strong">
                {['anomalyDetection.colPolicyName', 'common.type', 'anomalyDetection.colLimit', 'common.status', 'anomalyDetection.colLastTriggered', 'common.actions'].map(h => (
                  <Table.Head key={h} className="px-4 py-3 text-left">{t(h)}</Table.Head>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body className="divide-y divide-edge">
              {cLoading ? (
                <Table.Row><Table.Cell colSpan={6} className="px-4 py-10 text-center text-muted">{t('common.loading')}</Table.Cell></Table.Row>
              ) : (constraints ?? []).length === 0 ? (
                <Table.Row><Table.Cell colSpan={6} className="px-4 py-10 text-center text-muted">{t('anomalyDetection.noPolicies')}</Table.Cell></Table.Row>
              ) : (constraints ?? []).map(c => (
                <Table.Row key={c.id} className="hover:bg-subtle">
                  <Table.Cell className="px-4 py-3 font-medium text-primary">{c.name}</Table.Cell>
                  <Table.Cell className="px-4 py-3"><span className="px-2 py-0.5 bg-accent-soft text-accent rounded text-xs">{t(`anomalyDetection.constraintType.${c.constraint_type}`, { defaultValue: c.constraint_type })}</span></Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary">{c.limit_value != null ? fmt(c.limit_value) : '—'}</Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.is_active ? 'bg-success/10 text-success' : 'bg-emphasis text-secondary'}`}>
                      {c.is_active ? t('common.active') : t('common.inactive')}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{c.last_triggered_at ? c.last_triggered_at.slice(0, 16) : t('common.never')}</Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <Button size="sm" variant="secondary-destructive" onClick={() => deleteConstraint.mutate(c.id)}>{t('common.delete')}</Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <NativeDialog className="items-center justify-center p-4" label={t('anomalyDetection.newPolicy')} onClose={() => setShowCreate(false)}>

          <div className="dialog-panel relative p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-primary">{t('anomalyDetection.newPolicy')}</h3>
            <div className="space-y-3">
              <div>
                <Input label={t('common.name')} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full" />
              </div>
              <div>
                <SelectField
                  label={t('common.type')}
                  value={form.constraint_type}
                  onValueChange={value => setForm(f => ({ ...f, constraint_type: value }))}
                  className="w-full"
                  items={TYPES.map(type => ({ value: type, label: t(`anomalyDetection.constraintType.${type}`, { defaultValue: type }) }))}
                />
              </div>
              <div>
                <Input label={t('anomalyDetection.limitValue')} type="number" value={form.limit_value} onChange={e => setForm(f => ({ ...f, limit_value: e.target.value }))}
                  className="w-full" />
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={() => setShowCreate(false)} className="flex-1">{t('common.cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => createConstraint.mutate({ name: form.name, constraint_type: form.constraint_type, limit_value: form.limit_value ? parseFloat(form.limit_value) : null })}
                disabled={!form.name || createConstraint.isPending}
                className="flex-1"
              >
                {t('anomalyDetection.create')}
              </Button>
            </div>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
