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
  threshold: number
  description: string
}

const DEFAULT_FORM: AlertForm = {
  pool_id: '',
  alert_type: 'PERCENTAGE',
  threshold: 80,
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
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-800 last:border-0">
      <div className="flex items-center gap-3">
        <span className="text-yellow-400 text-lg">⚡</span>
        <div>
          <p className="text-sm text-white">
            {t('alerts.alertAt', {
              value:
                alert.alert_type === 'ABSOLUTE'
                  ? `$${alert.threshold.toLocaleString()}`
                  : `${alert.threshold}%`,
            })}
          </p>
          {alert.description && (
            <p className="text-xs text-gray-500 mt-0.5">{alert.description}</p>
          )}
        </div>
        <span
          className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${
            alert.alert_type === 'ABSOLUTE'
              ? 'bg-blue-900/40 text-blue-300'
              : 'bg-purple-900/40 text-purple-300'
          }`}
        >
          {t(`status.${alert.alert_type}`, { defaultValue: alert.alert_type })}
        </span>
        {!alert.is_active && (
          <span className="px-2 py-0.5 rounded-full text-xs bg-gray-700 text-gray-400">
            {t('common.inactive')}
          </span>
        )}
      </div>
      <button
        onClick={onDelete}
        disabled={isDeleting}
        className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50"
      >
        {t('common.delete')}
      </button>
    </div>
  )
}

export default function Alerts() {
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
    mutationFn: (payload: AlertForm) => api.post(`/orgs/${orgId}/alerts`, payload),
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

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('alerts.title')}</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => evaluateMutation.mutate()}
            disabled={evaluateMutation.isPending}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-60 text-gray-200 text-sm font-medium rounded-lg border border-gray-700 transition-colors"
          >
            {evaluateMutation.isPending ? t('alerts.evaluating') : t('alerts.evaluateNow')}
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {t('alerts.newAlert')}
          </button>
        </div>
      </div>

      {evaluationSummary && (
        <div className="mb-5 bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-4 justify-between">
            <div>
              <p className="text-sm font-medium text-white">{t('alerts.latestEvaluation')}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('alerts.evaluationResult', {
                  evaluated: evaluationSummary.evaluated,
                  triggered: evaluationSummary.triggered,
                })}
              </p>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs bg-indigo-900/40 text-indigo-300">
              {t('alerts.newEvents', { count: evaluationSummary.triggered })}
            </span>
          </div>

          {evaluationSummary.events.length > 0 ? (
            <div className="mt-4 space-y-2">
              {evaluationSummary.events.slice(0, 3).map((event) => (
                <div key={event.event_id} className="rounded-lg bg-gray-950/60 border border-gray-800 px-3 py-2">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm text-white">{event.message}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {t('alerts.thresholdActual', {
                          threshold: event.threshold.toFixed(2),
                          actual: event.actual.toFixed(2),
                        })}
                      </p>
                    </div>
                    <span className="text-xs text-gray-400 flex-shrink-0 uppercase">
                      {t(`status.${event.alert_type}`, { defaultValue: event.alert_type })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-gray-500">
              {t('alerts.noBreaches')}
            </p>
          )}
        </div>
      )}

      {alertsError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('alerts.loadFailed')}
        </div>
      )}

      {alertsLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : alerts.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
          {t('alerts.empty')}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Alerts grouped by pool */}
          {Array.from(alertsByPool.entries()).map(([poolId, poolAlerts]) => {
            const pool = pools.find((p) => p.id === poolId)
            return (
              <div key={poolId} className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-sm font-semibold text-white">
                    🗂 {pool?.name ?? t('alerts.poolFallback', { id: poolId.slice(0, 8) })}
                  </h3>
                  {pool?.monthly_budget && (
                    <span className="text-xs text-gray-500">
                      {t('alerts.budgetPerMonth', { amount: pool.monthly_budget.toLocaleString() })}
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
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
              <h3 className="text-sm font-semibold text-white mb-1">🏢 {t('alerts.orgLevel')}</h3>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-xl p-6 w-full max-w-lg border border-gray-800 shadow-xl">
            <h3 className="text-base font-semibold text-white mb-4">{t('alerts.newBudgetAlert')}</h3>
            {formError && (
              <div className="mb-3 p-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">
                {formError}
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  {t('alerts.poolLabel')}{' '}
                  <span className="text-gray-600">{t('alerts.poolOptionalHint')}</span>
                </label>
                <select
                  value={form.pool_id}
                  onChange={(e) => setForm({ ...form, pool_id: e.target.value })}
                  className={inputCls}
                >
                  <option value="">{t('alerts.orgLevelOption')}</option>
                  {pools.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.monthly_budget ? t('alerts.optionBudget', { amount: p.monthly_budget.toLocaleString() }) : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('alerts.alertType')}</label>
                <div className="flex gap-4">
                  {(['PERCENTAGE', 'ABSOLUTE'] as const).map((type) => (
                    <label key={type} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="alert-type"
                        value={type}
                        checked={form.alert_type === type}
                        onChange={() => setForm({ ...form, alert_type: type })}
                        className="accent-indigo-600"
                      />
                      <span className="text-sm text-gray-300">
                        {type === 'PERCENTAGE' ? t('alerts.typePercentage') : t('alerts.typeAbsolute')}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  {t('alerts.threshold')}{' '}
                  {form.alert_type === 'PERCENTAGE' ? t('alerts.thresholdPct') : t('alerts.thresholdAmount')}
                </label>
                <input
                  required
                  type="number"
                  min={0}
                  step={form.alert_type === 'PERCENTAGE' ? 1 : 0.01}
                  max={form.alert_type === 'PERCENTAGE' ? 100 : undefined}
                  value={form.threshold}
                  onChange={(e) =>
                    setForm({ ...form, threshold: parseFloat(e.target.value) || 0 })
                  }
                  className={inputCls}
                  placeholder={form.alert_type === 'PERCENTAGE' ? '80' : '5000'}
                />
                <p className="text-xs text-gray-600 mt-1">
                  {form.alert_type === 'PERCENTAGE'
                    ? t('alerts.helpPercentage')
                    : t('alerts.helpAbsolute')}
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  {t('common.description')}{' '}
                  <span className="text-gray-600">{t('alerts.optional')}</span>
                </label>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className={inputCls}
                  placeholder={t('alerts.descriptionPlaceholder')}
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {createMutation.isPending ? t('alerts.creating') : t('alerts.createAlert')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
