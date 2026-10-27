import { useDeferredValue, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useOrgStore } from '../store/orgStore'
import type { Recommendation } from '../types'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-warning/10 text-warning',
  dismissed: 'bg-emphasis text-secondary',
  applied: 'bg-success/10 text-success',
}

interface Category {
  key: string
  label: string
  icon: string
  types?: string[]
}

const CATEGORIES: Category[] = [
  { key: 'all', label: 'All', icon: '📋' },
  {
    key: 'idle',
    label: 'Idle',
    icon: '💤',
    types: ['abandoned_volume', 'abandoned_instance', 'abandoned_ip', 'abandoned_lb', 'abandoned_snapshot', 'abandoned_s3_bucket', 'instance_for_shutdown', 'volumes_not_attached', 'idle_resource'],
  },
  {
    key: 'rightsizing',
    label: 'Rightsizing',
    icon: '⚖️',
    types: ['rightsizing_instance', 'rightsizing_rds', 'rightsizing'],
  },
  {
    key: 'storage',
    label: 'Storage',
    icon: '🗄️',
    types: ['abandoned_snapshot', 'old_snapshot', 's3_intelligent_tiering'],
  },
  {
    key: 'security',
    label: 'Security',
    icon: '🔒',
    types: ['inactive_iam_user', 'security_group_unused', 'public_ip_unused'],
  },
  {
    key: 'commitment',
    label: 'Commitment',
    icon: '💰',
    types: ['reserved_instance', 'savings_plan_opportunity', 'commitment_opportunity'],
  },
]

const ACTION_STEPS: Record<string, string[]> = {
  abandoned_volume: ['abandonedVolume1', 'abandonedVolume2', 'abandonedVolume3'],
  abandoned_instance: ['abandonedInstance1', 'abandonedInstance2', 'abandonedInstance3'],
  abandoned_ip: ['abandonedIp1', 'abandonedIp2'],
  abandoned_lb: ['abandonedLb1', 'abandonedLb2', 'abandonedLb3'],
  volumes_not_attached: ['volumesNotAttached1', 'volumesNotAttached2', 'volumesNotAttached3'],
  rightsizing_instance: ['rightsizingInstance1', 'rightsizingInstance2', 'rightsizingInstance3'],
  rightsizing_rds: ['rightsizingRds1', 'rightsizingRds2', 'rightsizingRds3'],
  reserved_instance: ['reservedInstance1', 'reservedInstance2', 'reservedInstance3'],
  savings_plan_opportunity: ['savingsPlan1', 'savingsPlan2', 'savingsPlan3'],
  inactive_iam_user: ['inactiveIamUser1', 'inactiveIamUser2', 'inactiveIamUser3'],
  s3_intelligent_tiering: ['s3Tiering1', 's3Tiering2'],
}

const GENERIC_ACTION_STEPS = ['generic1', 'generic2']

function getActionSteps(recType: string): string[] {
  return ACTION_STEPS[recType] ?? GENERIC_ACTION_STEPS
}

function formatTimestamp(value?: string | null) {
  if (!value) return '—'

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'

  return parsed.toLocaleString()
}

function RecModal({
  rec,
  onDismiss,
  onReactivate,
  onApply,
  onVerify,
  onClose,
  isBusy,
}: {
  rec: Recommendation
  onDismiss: () => void
  onReactivate: () => void
  onApply: () => void
  onVerify: () => void
  onClose: () => void
  isBusy: boolean
}) {
  const { t } = useTranslation()
  const steps = getActionSteps(rec.rec_type).map((k) => t(`recommendations.actionStep.${k}`))
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-edge rounded-xl w-full max-w-lg shadow-2xl">
        <div className="p-5 border-b border-edge flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[rec.status] ?? STATUS_COLORS.active}`}>
                {t(`recStatus.${rec.status}`, { defaultValue: rec.status })}
              </span>
              <span className="text-xs text-muted uppercase">
                {t(`recType.${rec.rec_type}`, { defaultValue: rec.rec_type })}
              </span>
            </div>
            <h3 className="text-lg font-semibold text-primary">{rec.title}</h3>
          </div>
          <button onClick={onClose} className="text-secondary hover:text-primary transition-colors text-xl leading-none ml-4">✕</button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-secondary text-sm">{rec.description}</p>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-subtle/60 rounded-lg p-3">
              <p className="text-xs text-muted mb-1">{t('recommendations.monthlyCost')}</p>
              <p className="text-primary font-semibold">${rec.current_monthly_cost.toFixed(2)}</p>
            </div>
            <div className="bg-success/10 border border-success/25 rounded-lg p-3">
              <p className="text-xs text-muted mb-1">{t('recommendations.potentialSavings')}</p>
              <p className="text-success font-semibold">${rec.potential_savings.toFixed(2)}/mo</p>
            </div>
          </div>

          {rec.cloud_resource_id && (
            <div className="bg-subtle/40 rounded-lg px-3 py-2">
              <span className="text-xs text-muted">{t('recommendations.resource')}</span>
              <span className="text-xs text-secondary font-mono">{rec.cloud_resource_id}</span>
            </div>
          )}

          {rec.status === 'dismissed' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-subtle/40 rounded-lg px-3 py-3">
                <p className="text-xs text-muted mb-1">{t('recommendations.dismissedAt')}</p>
                <p className="text-sm text-primary">{formatTimestamp(rec.dismissed_at)}</p>
              </div>
              <div className="bg-subtle/40 rounded-lg px-3 py-3">
                <p className="text-xs text-muted mb-1">{t('recommendations.dismissReason')}</p>
                <p className="text-sm text-primary">{rec.dismiss_reason || t('recommendations.noReasonRecorded')}</p>
              </div>
            </div>
          )}

          <div>
            <h4 className="text-primary font-medium text-sm mb-2">{t('recommendations.recommendedActions')}</h4>
            <ol className="space-y-2">
              {steps.map((step, i) => (
                <li key={i} className="flex gap-2 text-sm text-secondary">
                  <span className="text-info font-medium flex-shrink-0">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t border-edge">
          {rec.status === 'active' && (
            <>
              <button
                onClick={onApply}
                disabled={isBusy}
                className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent rounded-lg transition-colors"
              >
                {t('recommendations.apply')}
              </button>
              <button
                onClick={onDismiss}
                disabled={isBusy}
                className="px-4 py-2 text-sm text-secondary hover:text-primary border border-strong hover:border-strong rounded-lg transition-colors"
              >
                {t('recommendations.dismiss')}
              </button>
            </>
          )}
          {rec.status === 'applied' && (
            <button
              onClick={onVerify}
              disabled={isBusy}
              className="px-4 py-2 text-sm bg-success-solid hover:bg-success-solid/90 disabled:opacity-60 text-white rounded-lg transition-colors"
            >
              {t('recommendations.verifySavings')}
            </button>
          )}
          {rec.status === 'dismissed' && (
            <button
              onClick={onReactivate}
              disabled={isBusy}
              className="px-4 py-2 text-sm bg-success-solid hover:bg-success-solid/90 disabled:opacity-60 text-white rounded-lg transition-colors"
            >
              {t('recommendations.restore')}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors ml-auto"
          >
            {t('recommendations.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Recommendations() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [activeCategory, setActiveCategory] = useState('all')
  const [selectedRec, setSelectedRec] = useState<Recommendation | null>(null)
  const [searchText, setSearchText] = useState('')

  const isArchiveView = location.pathname.endsWith('/archived')
  const deferredSearch = useDeferredValue(searchText.trim())

  // Real server paging replaces the old `limit: 200` cap; status + search run
  // server-side, the category tabs filter the current page client-side.
  const { query, rows, page, perPage, totalPages, setPage, setPerPage } =
    usePagination<Recommendation>(
      ['recommendations', orgId, isArchiveView ? 'dismissed' : 'active', deferredSearch],
      (p, pp) =>
        paginatedGet<Recommendation>(`/orgs/${orgId}/recommendations`, {
          page: p,
          per_page: pp,
          status: isArchiveView ? 'dismissed' : 'active',
          ...(deferredSearch ? { search: deferredSearch } : {}),
        }),
      { defaultPerPage: 50, enabled: !!orgId },
    )
  const { isLoading, isError } = query
  const data = rows

  const applyMutation = useMutation({
    mutationFn: (recId: string) => api.post(`/orgs/${orgId}/recommendations/${recId}/apply`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recommendations', orgId] }),
  })

  const verifyMutation = useMutation({
    mutationFn: (recId: string) => {
      const actual = window.prompt(t('recommendations.actualSavingsPrompt'), '0')
      if (actual === null) return Promise.reject(new Error('cancelled'))
      return api.post(`/orgs/${orgId}/recommendations/${recId}/verify`, {
        actual_savings: Number(actual) || 0,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recommendations', orgId] }),
  })

  const dismissMutation = useMutation({
    mutationFn: (recId: string) =>
      api.post(`/orgs/${orgId}/recommendations/${recId}/dismiss`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recommendations', orgId] })
      queryClient.invalidateQueries({ queryKey: ['dashboard', orgId] })
      setSelectedRec(null)
    },
  })

  const reactivateMutation = useMutation({
    mutationFn: (recId: string) =>
      api.post(`/orgs/${orgId}/recommendations/${recId}/reactivate`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recommendations', orgId] })
      queryClient.invalidateQueries({ queryKey: ['dashboard', orgId] })
      setSelectedRec(null)
    },
  })

  const runMutation = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/recommendations/run`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recommendations', orgId] })
    },
  })

  const activeData = data.filter((r) => r.status === 'active')
  const archivedData = data.filter((r) => r.status === 'dismissed')

  const getFilteredByCategory = (cat: Category): Recommendation[] => {
    if (!cat.types) return activeData
    return activeData.filter((r) => cat.types!.includes(r.rec_type))
  }

  const currentCategory = CATEGORIES.find((c) => c.key === activeCategory) ?? CATEGORIES[0]
  const filteredRecs = isArchiveView ? archivedData : getFilteredByCategory(currentCategory)

  const totalSavings = filteredRecs.reduce((s, r) => s + (r.potential_savings ?? 0), 0)
  const latestDismissedAt = useMemo(() => {
    if (!archivedData.length) return null

    const timestamps = archivedData
      .map((rec) => rec.dismissed_at)
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter((value) => !Number.isNaN(value))

    if (!timestamps.length) return null
    return new Date(Math.max(...timestamps)).toISOString()
  }, [archivedData])

  // Savings breakdown by category (excluding 'all')
  const savingsByCategory = CATEGORIES.filter((c) => c.key !== 'all').map((cat) => ({
    ...cat,
    savings: getFilteredByCategory(cat).reduce((s, r) => s + (r.potential_savings ?? 0), 0),
    count: getFilteredByCategory(cat).length,
  }))

  const mutationBusy = dismissMutation.isPending || reactivateMutation.isPending

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="page-title">{t('recommendations.title')}</h2>
          <p className="text-sm text-secondary mt-1">
            {isArchiveView ? t('recommendations.subtitleArchived') : t('recommendations.subtitleActive')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-edge bg-surface p-1">
            <button
              onClick={() => navigate('/recommendations')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${!isArchiveView ? 'bg-accent text-on-accent' : 'text-secondary hover:text-primary'}`}
            >
              {t('common.active')}
            </button>
            <button
              onClick={() => navigate('/recommendations/archived')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${isArchiveView ? 'bg-accent text-on-accent' : 'text-secondary hover:text-primary'}`}
            >
              {t('recommendations.tabArchived')}
            </button>
          </div>
          {!isArchiveView && (
            <button
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-medium rounded-lg transition-colors"
            >
              {runMutation.isPending ? t('recommendations.running') : t('recommendations.runEngine')}
            </button>
          )}
        </div>
      </div>

      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative max-w-md w-full">
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={isArchiveView ? t('recommendations.searchArchived') : t('recommendations.searchActive')}
            className="w-full rounded-xl border border-edge bg-surface px-4 py-2.5 text-sm text-primary placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        {isArchiveView && (
          <p className="text-xs text-muted">
            {t('recommendations.restoreWarning')}
          </p>
        )}
      </div>

      {/* Summary bar */}
      {!isArchiveView && activeData.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-surface border border-edge rounded-xl p-4 text-center">
            <p className="text-xs text-secondary mb-1">{t('common.active')}</p>
            <p className="text-2xl font-bold text-primary">{activeData.length}</p>
          </div>
          <div className="bg-surface border border-edge rounded-xl p-4 text-center">
            <p className="text-xs text-secondary mb-1">{t('recommendations.potentialSavings')}</p>
            <p className="text-2xl font-bold text-success">
              ${activeData.reduce((s, r) => s + (r.potential_savings ?? 0), 0).toFixed(0)}/mo
            </p>
          </div>
          <div className="bg-surface border border-edge rounded-xl p-4 text-center">
            <p className="text-xs text-secondary mb-1">{t('recommendations.currentCostAffected')}</p>
            <p className="text-2xl font-bold text-primary">
              ${activeData.reduce((s, r) => s + (r.current_monthly_cost ?? 0), 0).toFixed(0)}/mo
            </p>
          </div>
        </div>
      )}

      {isArchiveView && archivedData.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-surface border border-edge rounded-xl p-4 text-center">
            <p className="text-xs text-secondary mb-1">{t('recommendations.tabArchived')}</p>
            <p className="text-2xl font-bold text-primary">{archivedData.length}</p>
          </div>
          <div className="bg-surface border border-edge rounded-xl p-4 text-center">
            <p className="text-xs text-secondary mb-1">{t('recommendations.recoverableSavings')}</p>
            <p className="text-2xl font-bold text-success">${archivedData.reduce((s, r) => s + (r.potential_savings ?? 0), 0).toFixed(0)}/mo</p>
          </div>
          <div className="bg-surface border border-edge rounded-xl p-4 text-center">
            <p className="text-xs text-secondary mb-1">{t('recommendations.lastDismissed')}</p>
            <p className="text-sm font-semibold text-primary">{formatTimestamp(latestDismissedAt)}</p>
          </div>
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('recommendations.loadFailed')}
        </div>
      )}

      {/* Category tabs */}
      {!isArchiveView && (
        <div className="flex gap-1 flex-wrap mb-4">
          {CATEGORIES.map((cat) => {
            const count = cat.key === 'all' ? activeData.length : getFilteredByCategory(cat).length
            return (
              <button
                key={cat.key}
                onClick={() => setActiveCategory(cat.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  activeCategory === cat.key
                    ? 'bg-accent text-on-accent'
                    : 'bg-subtle text-secondary hover:text-primary'
                }`}
              >
                <span>{cat.icon}</span>
                <span>{t(`recCategory.${cat.key}`, { defaultValue: cat.label })}</span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full ${
                    activeCategory === cat.key ? 'bg-accent text-on-accent' : 'bg-emphasis text-secondary'
                  }`}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Savings breakdown by category */}
      {!isArchiveView && activeData.length > 0 && (
        <div className="bg-surface border border-edge rounded-xl p-4 mb-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-secondary">
              {t('recommendations.showingCount', { count: filteredRecs.length })}
            </span>
            <span className="text-sm font-semibold text-success">
              {t('recommendations.totalPotentialSavings', { amount: totalSavings.toFixed(0) })}
            </span>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted">
            {savingsByCategory
              .filter((c) => c.savings > 0)
              .map((c) => (
                <span key={c.key}>
                  {c.icon} {t(`recCategory.${c.key}`, { defaultValue: c.label })}{' '}
                  <span className="text-success/80">${c.savings.toFixed(0)}</span>
                </span>
              ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : filteredRecs.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {!isArchiveView && activeData.length === 0
            ? t('recommendations.noActive')
            : isArchiveView
              ? t('recommendations.noArchivedMatch')
              : t('recommendations.noCategory')}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredRecs.map((rec) => (
            <div
              key={rec.id}
              className="bg-surface border border-edge rounded-xl p-5 cursor-pointer hover:border-strong transition-colors"
              onClick={() => setSelectedRec(rec)}
            >
              <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[rec.status] ?? STATUS_COLORS.active}`}>
                      {t(`recStatus.${rec.status}`, { defaultValue: rec.status })}
                    </span>
                    <span className="text-xs text-muted uppercase">
                      {t(`recType.${rec.rec_type}`, { defaultValue: rec.rec_type })}
                    </span>
                  </div>
                  <h3 className="font-semibold text-primary">{rec.title}</h3>
                  <p className="text-sm text-secondary mt-1 line-clamp-2">{rec.description}</p>
                  {rec.status === 'dismissed' && (
                    <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
                      <span>{t('recommendations.dismissedAtLabel', { date: formatTimestamp(rec.dismissed_at) })}</span>
                      <span>{t('recommendations.reasonLabel', { reason: rec.dismiss_reason || t('recommendations.noReasonRecorded') })}</span>
                    </div>
                  )}
                </div>
                <div className="flex w-full sm:w-auto sm:flex-col items-center sm:items-end justify-between gap-2 flex-shrink-0">
                  <div className="text-left sm:text-right">
                    <p className="text-xs text-muted">{t('recommendations.potentialSavings')}</p>
                    <p className="text-lg font-bold text-success">${rec.potential_savings.toFixed(2)}/mo</p>
                    <p className="text-xs text-muted mt-0.5">
                      {t('recommendations.currentCost', { amount: rec.current_monthly_cost.toFixed(2) })}
                    </p>
                  </div>
                  {rec.status === 'active' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); dismissMutation.mutate(rec.id) }}
                      disabled={mutationBusy}
                      className="px-3 py-1 text-xs text-secondary hover:text-primary border border-strong hover:border-strong rounded-lg transition-colors disabled:opacity-50"
                    >
                      {t('recommendations.dismiss')}
                    </button>
                  )}
                  {rec.status === 'dismissed' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); reactivateMutation.mutate(rec.id) }}
                      disabled={mutationBusy}
                      className="px-3 py-1 text-xs bg-success-solid hover:bg-success-solid/90 text-white rounded-lg transition-colors disabled:opacity-50"
                    >
                      {t('recommendations.restore')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <PaginationBar
        page={page}
        totalPages={totalPages}
        total={query.data?.meta.total ?? 0}
        perPage={perPage}
        onPageChange={setPage}
        onPerPageChange={setPerPage}
      />

      {/* Detail modal */}
      {selectedRec && (
        <RecModal
          rec={selectedRec}
          onDismiss={() => dismissMutation.mutate(selectedRec.id)}
          onReactivate={() => reactivateMutation.mutate(selectedRec.id)}
          onApply={() => applyMutation.mutate(selectedRec.id)}
          onVerify={() => verifyMutation.mutate(selectedRec.id)}
          onClose={() => setSelectedRec(null)}
          isBusy={mutationBusy || applyMutation.isPending || verifyMutation.isPending}
        />
      )}
    </div>
  )
}
