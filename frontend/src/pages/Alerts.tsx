import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useMoneyFormatter, useOrgCurrency } from '../lib/format'
import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useOrgStore } from '../store/orgStore'
import type { AlertEvaluationSummary, BudgetAlert, Pool } from '../types'

interface AlertForm {
  pool_id: string
  alert_type: 'ABSOLUTE' | 'PERCENTAGE'
  threshold: string
  description: string
}

const DEFAULT_FORM: AlertForm = {
  pool_id: '',
  alert_type: 'PERCENTAGE',
  threshold: '80',
  description: '',
}

function AlertCard({
  alert,
  onDelete,
  isDeleting,
}: {
  alert: BudgetAlert
  onDelete: () => void
  isDeleting: boolean
}) {
  const fmt = useMoneyFormatter()
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between py-3 border-b border-edge last:border-0">
      <div className="flex items-center gap-3">
        <span className="text-warning text-lg">⚡</span>
        <div>
          <p className="text-sm text-primary">
            {t('alerts.alertAt', {
              value:
                alert.alert_type === 'ABSOLUTE'
                  ? fmt(alert.threshold)
                  : `${alert.threshold}%`,
            })}
          </p>
          {alert.description && (
            <p className="text-xs text-muted mt-0.5">{alert.description}</p>
          )}
        </div>
        <span
          className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${
            alert.alert_type === 'ABSOLUTE'
              ? 'bg-info/10 text-info'
              : 'bg-violet/10 text-violet'
          }`}
        >
          {t(`status.${alert.alert_type}`, { defaultValue: alert.alert_type })}
        </span>
        {!alert.is_active && (
          <span className="px-2 py-0.5 rounded-full text-xs bg-emphasis text-secondary">
            {t('common.inactive')}
          </span>
        )}
      </div>
      <button
        onClick={onDelete}
        disabled={isDeleting}
        className="text-danger hover:text-danger text-xs disabled:opacity-50"
      >
        {t('common.delete')}
      </button>
    </div>
  )
}

export default function Alerts() {
  const currency = useOrgCurrency()
  const fmt = useMoneyFormatter()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<AlertForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')
  const [evaluationSummary, setEvaluationSummary] = useState<AlertEvaluationSummary | null>(null)

  const { query: alertsQuery, rows: alerts, page, perPage, totalPages, setPage, setPerPage } =
    usePagination<BudgetAlert>(
      ['alerts', orgId],
      (p, pp) => paginatedGet<BudgetAlert>(`/orgs/${orgId}/alerts`, { page: p, per_page: pp }),
      { defaultPerPage: 50, enabled: !!orgId },
    )
  const { isLoading: alertsLoading, isError: alertsError } = alertsQuery

  const { data: pools = [] } = useQuery<Pool[]>({
    queryKey: ['pools', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Pool[] }>(`/orgs/${orgId}/pools`)
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: (draft: AlertForm) => api.post(`/orgs/${orgId}/alerts`, { ...draft, threshold: Number(draft.threshold) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('alerts.createFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/alerts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts', orgId] }),
  })

  const evaluateMutation = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/alerts/evaluate`),
    onSuccess: (response) => {
      setEvaluationSummary(response.data.data ?? null)
      queryClient.invalidateQueries({ queryKey: ['alerts', orgId] })
    },
  })

  function closeModal() {
    setShowModal(false)
    setForm(DEFAULT_FORM)
    setFormError('')
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    createMutation.mutate(form)
  }

  // Group alerts by pool
  const alertsByPool: Map<string, BudgetAlert[]> = new Map()
  const noPoolAlerts: BudgetAlert[] = []

  for (const alert of alerts) {
    if (alert.pool_id) {
      const existing = alertsByPool.get(alert.pool_id) ?? []
      existing.push(alert)
      alertsByPool.set(alert.pool_id, existing)
    } else {
      noPoolAlerts.push(alert)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('alerts.title')}</h1>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => evaluateMutation.mutate()}
            disabled={evaluateMutation.isPending}
          >
            {evaluateMutation.isPending ? t('alerts.evaluating') : t('alerts.evaluateNow')}
          </Button>
          <Button
            variant="primary"
            onClick={() => setShowModal(true)}
          >
            {t('alerts.newAlert')}
          </Button>
        </div>
      </div>

      {evaluationSummary && (
        <div className="mb-5 bg-surface border border-edge rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-4 justify-between">
            <div>
              <p className="text-sm font-medium text-primary">{t('alerts.latestEvaluation')}</p>
              <p className="text-xs text-muted mt-0.5">
                {t('alerts.evaluationResult', {
                  evaluated: evaluationSummary.evaluated,
                  triggered: evaluationSummary.triggered,
                })}
              </p>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs bg-accent-soft/40 text-accent">
              {t('alerts.newEvents', { count: evaluationSummary.triggered })}
            </span>
          </div>

          {evaluationSummary.events.length > 0 ? (
            <div className="mt-4 space-y-2">
              {evaluationSummary.events.slice(0, 3).map((event) => (
                <div key={event.event_id} className="rounded-lg bg-canvas/60 border border-edge px-3 py-2">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm text-primary">{event.message}</p>
                      <p className="text-xs text-muted mt-0.5">
                        {t('alerts.thresholdActual', {
                          threshold: event.alert_type === 'PERCENTAGE' ? event.threshold.toFixed(2) + '%' : fmt(event.threshold),
                          actual: event.alert_type === 'PERCENTAGE' ? event.actual.toFixed(2) + '%' : fmt(event.actual),
                        })}
                      </p>
                    </div>
                    <span className="text-xs text-secondary flex-shrink-0 uppercase">
                      {t(`status.${event.alert_type}`, { defaultValue: event.alert_type })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              {t('alerts.noBreaches')}
            </p>
          )}
        </div>
      )}

      {alertsError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('alerts.loadFailed')}
        </div>
      )}

      {alertsLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : alerts.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {t('alerts.empty')}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Alerts grouped by pool */}
          {Array.from(alertsByPool.entries()).map(([poolId, poolAlerts]) => {
            const pool = pools.find((p) => p.id === poolId)
            return (
              <div key={poolId} className="bg-surface border border-edge rounded-xl px-5 py-4">
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-sm font-semibold text-primary">
                    🗂 {pool?.name ?? t('alerts.poolFallback', { id: poolId.slice(0, 8) })}
                  </h3>
                  {pool?.monthly_budget && (
                    <span className="text-xs text-muted">
                      {t('alerts.budgetPerMonth', { amount: fmt(pool.monthly_budget) })}
                    </span>
                  )}
                </div>
                <div>
                  {poolAlerts.map((alert) => (
                    <AlertCard
                      key={alert.id}
                      alert={alert}
                      onDelete={() => deleteMutation.mutate(alert.id)}
                      isDeleting={deleteMutation.isPending}
                    />
                  ))}
                </div>
              </div>
            )
          })}

          {/* Org-level alerts (no pool) */}
          {noPoolAlerts.length > 0 && (
            <div className="bg-surface border border-edge rounded-xl px-5 py-4">
              <h3 className="text-sm font-semibold text-primary mb-1">🏢 {t('alerts.orgLevel')}</h3>
              <div>
                {noPoolAlerts.map((alert) => (
                  <AlertCard
                    key={alert.id}
                    alert={alert}
                    onDelete={() => deleteMutation.mutate(alert.id)}
                    isDeleting={deleteMutation.isPending}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <PaginationBar
        page={page}
        totalPages={totalPages}
        total={alertsQuery.data?.meta.total ?? 0}
        perPage={perPage}
        onPageChange={setPage}
        onPerPageChange={setPerPage}
      />

      {/* Create Alert Modal */}
      {showModal && (
        <NativeDialog className="items-center justify-center p-4" label={t('alerts.newBudgetAlert')} onClose={closeModal}>
          <div className="dialog-panel p-6 w-full max-w-lg">
            <h3 className="text-base font-semibold text-primary mb-4">{t('alerts.newBudgetAlert')}</h3>
            {formError && (
              <div className="mb-3 p-2 rounded bg-danger/10 border border-danger/25 text-danger text-sm">
                {formError}
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <SelectField
                  label={<>{t('alerts.poolLabel')}{' '}
                  <span className="text-muted">{t('alerts.poolOptionalHint')}</span></>}
                  value={form.pool_id}
                  onValueChange={value => setForm({ ...form, pool_id: value })}
                  className="w-full"
                  items={[
                    { value: "", label: t('alerts.orgLevelOption') },
                    ...pools.map((p) => ({ value: p.id, label: `${p.name}${p.monthly_budget ? t('alerts.optionBudget', { amount: fmt(p.monthly_budget) }) : ''}` })),
                  ]}
                />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">{t('alerts.alertType')}</label>
                <div className="flex gap-4">
                  {(['PERCENTAGE', 'ABSOLUTE'] as const).map((type) => (
                    <label key={type} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="alert-type"
                        value={type}
                        checked={form.alert_type === type}
                        onChange={() => setForm({ ...form, alert_type: type })}
                      />
                      <span className="text-sm text-secondary">
                        {type === 'PERCENTAGE' ? t('alerts.typePercentage') : t('alerts.typeAbsolute')}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <Input label={`${t('alerts.threshold')} ${form.alert_type === 'PERCENTAGE' ? t('alerts.thresholdPct') : t('alerts.thresholdAmount', { currency })}`}
                  required
                  type="number"
                  min={0}
                  step={form.alert_type === 'PERCENTAGE' ? 1 : 0.01}
                  max={form.alert_type === 'PERCENTAGE' ? 100 : undefined}
                  value={form.threshold}
                  onChange={e => setForm({ ...form, threshold: e.target.value })}
                  className="w-full"
                  placeholder={form.alert_type === 'PERCENTAGE' ? '80' : '5000'}
                />
                <p className="text-xs text-muted mt-1">
                  {form.alert_type === 'PERCENTAGE'
                    ? t('alerts.helpPercentage')
                    : t('alerts.helpAbsolute')}
                </p>
              </div>
              <div>
                <Input label={<>{t('common.description')}{' '}
                  <span className="text-muted">{t('alerts.optional')}</span></>}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full"
                  placeholder={t('alerts.descriptionPlaceholder')}
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  onClick={closeModal}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? t('alerts.creating') : t('alerts.createAlert')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
