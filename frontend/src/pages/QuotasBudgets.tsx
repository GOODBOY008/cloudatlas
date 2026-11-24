import { PageTabs } from '../components/shared/PageTabs'
import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { chartColors, chartAxis, chartGrid } from '../lib/chartTheme'
import { useMoneyFormatter, useOrgCurrency } from '../lib/format'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface BudgetRow { pool_id: string | null; pool_name: string; pool_type: string; budget: number | null; actual: number; utilization_pct: number | null; status: string; variance: number | null }
interface Alert { id: string; name: string; threshold: number; alert_type: string; is_active: boolean; last_triggered_at: string | null }
interface Constraint { id: string; name: string; constraint_type: string; limit_value: number | null; is_active: boolean; last_triggered_at: string | null }


function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const cls: Record<string, string> = {
    over_budget: 'bg-danger/10 text-danger',
    warning: 'bg-warning/10 text-warning',
    on_track: 'bg-success/10 text-success',
    no_budget: 'bg-emphasis text-secondary',
  }
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls[status] ?? 'bg-emphasis text-secondary'}`}>{t(`status.${status}`, { defaultValue: status.replace('_', ' ') })}</span>
}

export default function QuotasBudgets() {
  const formatMoney = useMoneyFormatter()
  const currency = useOrgCurrency()
  const fmt = (value: number | null | undefined) => value == null ? '—' : formatMoney(value)
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
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('quotas.title')}</h1>
          <p className="text-sm text-secondary mt-1">{t('quotas.subtitle')}</p>
        </div>
        <div className="flex gap-3">
          <Button onClick={() => evaluateAlerts.mutate()} disabled={evaluateAlerts.isPending}>
            {t('quotas.evaluateAlerts')}
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t('quotas.totalBudget'), value: fmt(totalBudget), color: 'text-accent' },
          { label: t('quotas.totalSpend'), value: fmt(totalSpend), color: 'text-primary' },
          { label: t('status.over_budget'), value: String(overBudget), color: 'text-danger' },
          { label: t('status.warning'), value: String(warning), color: 'text-warning' },
        ].map(c => (
          <div key={c.label} className="bg-surface rounded-xl border border-strong p-5">
            <p className="text-xs text-secondary uppercase tracking-wider">{c.label}</p>
            <p className={`text-2xl font-semibold mt-1 ${c.color}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* Budget utilization chart */}
      {matrix.length > 0 && (
        <div className="bg-surface rounded-xl border border-strong p-5">
          <h2 className="text-sm font-semibold text-primary mb-4">{t('quotas.budgetUtilizationByPool')}</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={matrix.slice(0, 10).map(b => ({ name: b.pool_name?.slice(0, 14), pct: Math.round(b.utilization_pct ?? ((b.budget ?? 0) > 0 ? (b.actual / (b.budget ?? 1)) * 100 : 0)), status: b.status }))}>
              <CartesianGrid {...chartGrid}  vertical={false} />
              <XAxis {...chartAxis} dataKey="name" tick={{ fontSize: 10, fill: 'rgb(var(--text-muted))' }} />
              <YAxis {...chartAxis} tick={{ fontSize: 10, fill: 'rgb(var(--text-muted))' }} unit="%" domain={[0, 120]} />
              <Tooltip formatter={(v: number) => `${v}%`} />
              <Bar isAnimationActive={false} maxBarSize={32} dataKey="pct" radius={[4, 4, 0, 0]}>
                {matrix.slice(0, 10).map((b, i) => (
                  <Cell key={i} fill={b.status === 'over_budget' ? chartColors.danger : b.status === 'warning' ? chartColors.orange : chartColors.green} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tabs */}
      <PageTabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mb-5"
        tabs={[
          { value: 'budgets', label: t('quotas.poolBudgetsCount', { count: matrix.length }) },
          { value: 'alerts', label: t('quotas.alertRulesCount', { count: (alerts ?? []).length }) },
          { value: 'quotas', label: t('quotas.quotasCount', { count: (quotas ?? []).length }) },
        ]}
      />

      {activeTab === 'budgets' && (
        <div className="bg-surface rounded-xl border border-strong overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact"><Table.Row className="border-b border-strong">
              {[t('quotas.colPool'), t('quotas.colBudget'), t('quotas.colActualSpend'), t('quotas.colUtilization'), t('common.status')].map(h => (
                <Table.Head key={h} className="px-4 py-3 text-left">{h}</Table.Head>
              ))}
            </Table.Row></Table.Header>
            <Table.Body className="divide-y divide-edge">
              {matrix.length === 0 ? (
                <Table.Row><Table.Cell colSpan={5} className="px-4 py-10 text-center text-muted">{t('quotas.noPoolsWithBudgets')}</Table.Cell></Table.Row>
              ) : matrix.map((b, i) => {
                const pct = (b.budget ?? 0) > 0 ? Math.min((b.actual / (b.budget ?? 1)) * 100, 120) : 0
                const barColor = b.status === 'over_budget' ? 'bg-danger-solid' : b.status === 'warning' ? 'bg-warning-solid' : 'bg-success-solid'
                return (
                  <Table.Row key={i} className="hover:bg-subtle">
                    <Table.Cell className="px-4 py-3 font-medium text-primary">{b.pool_name}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary">{(b.budget ?? 0) > 0 ? fmt(b.budget) : '—'}</Table.Cell>
                    <Table.Cell className="px-4 py-3 font-semibold text-primary">{fmt(b.actual)}</Table.Cell>
                    <Table.Cell className="px-4 py-3 w-48">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-emphasis rounded-full h-2">
                          <div className={`h-2 rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="text-xs text-secondary w-12 text-right">{pct.toFixed(0)}%</span>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3"><StatusBadge status={b.status} /></Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table></div>
        </div>
      )}

      {activeTab === 'alerts' && (
        <>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setShowAlertForm(true)}>{t('quotas.addAlertRule')}</Button>
          </div>
          <div className="bg-surface rounded-xl border border-strong overflow-hidden">
            <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
              <Table.Header variant="compact"><Table.Row className="border-b border-strong">
                {[t('common.name'), t('common.type'), t('quotas.colThreshold'), t('common.status'), t('quotas.colLastTriggered'), t('common.actions')].map(h => (
                  <Table.Head key={h} className="px-4 py-3 text-left">{h}</Table.Head>
                ))}
              </Table.Row></Table.Header>
              <Table.Body className="divide-y divide-edge">
                {(alerts ?? []).length === 0 ? (
                  <Table.Row><Table.Cell colSpan={6} className="px-4 py-10 text-center text-muted">{t('quotas.noAlertRules')}</Table.Cell></Table.Row>
                ) : (alerts ?? []).map(a => (
                  <Table.Row key={a.id} className="hover:bg-subtle">
                    <Table.Cell className="px-4 py-3 font-medium text-primary">{a.name}</Table.Cell>
                    <Table.Cell className="px-4 py-3"><span className="px-2 py-0.5 bg-accent-soft text-accent rounded text-xs">{t(`status.${a.alert_type}`, { defaultValue: a.alert_type })}</span></Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary">{fmt(a.threshold)}</Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${a.is_active ? 'bg-success/10 text-success' : 'bg-emphasis text-secondary'}`}>
                        {a.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary text-xs">{a.last_triggered_at ? a.last_triggered_at.slice(0, 16) : t('common.never')}</Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      <Button size="sm" variant="secondary-destructive" onClick={() => deleteAlert.mutate(a.id)}>{t('common.delete')}</Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table></div>
          </div>
        </>
      )}

      {activeTab === 'quotas' && (
        <>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setShowQuotaForm(true)}>{t('quotas.addQuota')}</Button>
          </div>
          <div className="bg-surface rounded-xl border border-strong overflow-hidden">
            <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
              <Table.Header variant="compact"><Table.Row className="border-b border-strong">
                {[t('common.name'), t('common.type'), t('quotas.colLimit'), t('common.status'), t('quotas.colLastTriggered')].map(h => (
                  <Table.Head key={h} className="px-4 py-3 text-left">{h}</Table.Head>
                ))}
              </Table.Row></Table.Header>
              <Table.Body className="divide-y divide-edge">
                {(quotas ?? []).length === 0 ? (
                  <Table.Row><Table.Cell colSpan={5} className="px-4 py-10 text-center text-muted">{t('quotas.noQuotaConstraints')}</Table.Cell></Table.Row>
                ) : (quotas ?? []).map(q => (
                  <Table.Row key={q.id} className="hover:bg-subtle">
                    <Table.Cell className="px-4 py-3 font-medium text-primary">{q.name}</Table.Cell>
                    <Table.Cell className="px-4 py-3"><span className="px-2 py-0.5 bg-violet/10 text-violet rounded text-xs">{t(`status.${q.constraint_type}`, { defaultValue: q.constraint_type })}</span></Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary">{q.limit_value != null ? fmt(q.limit_value) : '—'}</Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${q.is_active ? 'bg-success/10 text-success' : 'bg-emphasis text-secondary'}`}>
                        {q.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary text-xs">{q.last_triggered_at ? q.last_triggered_at.slice(0, 16) : t('common.never')}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table></div>
          </div>
        </>
      )}

      {/* Alert form modal */}
      {showAlertForm && (
        <NativeDialog className="items-center justify-center p-4" label={t('quotas.newAlertRule')} onClose={() => setShowAlertForm(false)}>

          <div className="dialog-panel relative p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-primary">{t('quotas.newAlertRule')}</h3>
            {[
              { label: t('common.name'), field: 'name', type: 'text' },
              { label: t('quotas.thresholdAmount', { currency }), field: 'threshold', type: 'number' },
            ].map(({ label, field, type }) => (
              <div key={field}>
                <Input label={label} type={type} value={(alertForm as any)[field]} onChange={e => setAlertForm(f => ({ ...f, [field]: e.target.value }))}
                  className="w-full" />
              </div>
            ))}
            <div className="flex gap-3 pt-2">
              <Button onClick={() => setShowAlertForm(false)} className="flex-1">{t('common.cancel')}</Button>
              <Button variant="primary" onClick={() => createAlert.mutate({ name: alertForm.name, threshold: parseFloat(alertForm.threshold), alert_type: 'budget' })}
                disabled={!alertForm.name || !alertForm.threshold || createAlert.isPending}
                className="flex-1">
                {t('quotas.create')}
              </Button>
            </div>
          </div>
        </NativeDialog>
      )}

      {/* Quota form modal */}
      {showQuotaForm && (
        <NativeDialog className="items-center justify-center p-4" label={t('quotas.newQuota')} onClose={() => setShowQuotaForm(false)}>

          <div className="dialog-panel relative p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-primary">{t('quotas.newQuota')}</h3>
            <div>
              <Input label={t('common.name')} value={quotaForm.name} onChange={e => setQuotaForm(f => ({ ...f, name: e.target.value }))}
                className="w-full" />
            </div>
            <div>
              <SelectField
                label={t('common.type')}
                value={quotaForm.constraint_type}
                onValueChange={value => setQuotaForm(f => ({ ...f, constraint_type: value }))}
                className="w-full"
                items={[
                  { value: "total_expense", label: t('quotas.typeTotalExpense') },
                  { value: "resource_count", label: t('quotas.typeResourceCount') },
                ]}
              />
            </div>
            <div>
              <Input label={t('quotas.limitValue')} type="number" value={quotaForm.limit_value} onChange={e => setQuotaForm(f => ({ ...f, limit_value: e.target.value }))}
                className="w-full" />
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={() => setShowQuotaForm(false)} className="flex-1">{t('common.cancel')}</Button>
              <Button variant="primary" onClick={() => createQuota.mutate({ name: quotaForm.name, constraint_type: quotaForm.constraint_type, limit_value: parseFloat(quotaForm.limit_value) })}
                disabled={!quotaForm.name || !quotaForm.limit_value || createQuota.isPending}
                className="flex-1">
                {t('quotas.create')}
              </Button>
            </div>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
