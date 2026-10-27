import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'
import { providerLabel } from '../lib/providers'
import type { CI, CIBaseline, DriftRecord } from '../types'

interface BaselineForm {
  ci_id: string
  label: string
  snapshot: string
}

const DEFAULT_FORM: BaselineForm = { ci_id: '', label: '', snapshot: '{}' }

function ValueCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted">null</span>
  if (typeof value === 'object') {
    return (
      <code className="text-xs text-secondary font-mono">
        {JSON.stringify(value).slice(0, 80)}
        {JSON.stringify(value).length > 80 ? '…' : ''}
      </code>
    )
  }
  return <span className="text-secondary">{String(value)}</span>
}

export default function DriftDetection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [tab, setTab] = useState<'drift' | 'baselines'>('drift')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'acknowledged'>('all')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<BaselineForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')

  const { data: drift = [], isLoading, isError } = useQuery<DriftRecord[]>({
    queryKey: ['ci-drift', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: DriftRecord[] }>(`/orgs/${orgId}/ci-drift`)
      return res.data ?? []
    },
  })

  const { data: baselines = [], isLoading: baselinesLoading } = useQuery<CIBaseline[]>({
    queryKey: ['ci-baselines', orgId],
    enabled: !!orgId && tab === 'baselines',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIBaseline[] }>(`/orgs/${orgId}/ci-baselines`)
      return res.data ?? []
    },
  })

  const { data: cis = [] } = useQuery<CI[]>({
    queryKey: ['cis', orgId],
    enabled: !!orgId && showModal,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CI[] }>(`/orgs/${orgId}/cis?limit=500`)
      return res.data ?? []
    },
  })

  // T12: drift lifecycle closure.
  const resolveMutation = useMutation({
    mutationFn: (driftId: string) => api.post(`/orgs/${orgId}/ci-drift/${driftId}/resolve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-drift', orgId] }),
  })

  const ignoreMutation = useMutation({
    mutationFn: (driftId: string) => api.post(`/orgs/${orgId}/ci-drift/${driftId}/ignore`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-drift', orgId] }),
  })

  const acknowledgeMutation = useMutation({
    mutationFn: (driftId: string) => api.post(`/orgs/${orgId}/ci-drift/${driftId}/acknowledge`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-drift', orgId] }),
  })

  const createBaselineMutation = useMutation({
    mutationFn: (payload: { ci_id: string; snapshot: unknown; label?: string }) =>
      api.post(`/orgs/${orgId}/ci-baselines`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-baselines', orgId] })
      queryClient.invalidateQueries({ queryKey: ['ci-drift', orgId] })
      setShowModal(false)
      setForm(DEFAULT_FORM)
      setFormError('')
    },
    onError: () => setFormError(t('drift.captureFailed')),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.ci_id) {
      setFormError(t('drift.selectCiRequired'))
      return
    }
    let snapshot: unknown
    try {
      snapshot = JSON.parse(form.snapshot || '{}')
    } catch {
      setFormError(t('drift.snapshotInvalid'))
      return
    }
    createBaselineMutation.mutate({
      ci_id: form.ci_id,
      snapshot,
      ...(form.label.trim() ? { label: form.label.trim() } : {}),
    })
  }

  const visibleDrift = drift.filter((d) => {
    if (statusFilter === 'open') return !d.acknowledged_at
    if (statusFilter === 'acknowledged') return !!d.acknowledged_at
    return true
  })

  const inputCls =
    'bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm w-full focus:outline-none focus:ring-2 focus:ring-accent'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="page-title">{t('drift.title')}</h2>
        <button
          onClick={() => {
            setShowModal(true)
            setFormError('')
          }}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors"
        >
          {t('drift.captureBaseline')}
        </button>
      </div>

      <div className="flex gap-1 mb-4 border-b border-edge">
        {(['drift', 'baselines'] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === tabKey
                ? 'border-accent text-primary'
                : 'border-transparent text-muted hover:text-secondary'
            }`}
          >
            {tabKey === 'drift' ? t('drift.tabDrift') : t('drift.tabBaselines')}
          </button>
        ))}
      </div>

      {tab === 'drift' ? (
        <>
          <div className="flex items-center gap-2 mb-4">
            {(['all', 'open', 'acknowledged'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  statusFilter === s
                    ? 'bg-accent text-on-accent'
                    : 'bg-subtle text-secondary hover:text-primary'
                }`}
              >
                {s === 'all' ? t('drift.filterAll') : s === 'open' ? t('drift.filterOpen') : t('drift.filterAcknowledged')}
              </button>
            ))}
          </div>

          {isError && (
            <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
              {t('drift.loadFailed')}
            </div>
          )}

          {isLoading ? (
            <div className="text-muted text-sm">{t('common.loading')}</div>
          ) : visibleDrift.length === 0 ? (
            <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
              {drift.length === 0
                ? t('drift.empty')
                : t('drift.noMatchFilter')}
            </div>
          ) : (
            <div className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
                <thead className="border-b border-edge text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('cmdb.colCi')}</th>
                    <th className="px-4 py-3 font-medium">{t('drift.colField')}</th>
                    <th className="px-4 py-3 font-medium">{t('drift.colBaselineCurrent')}</th>
                    <th className="px-4 py-3 font-medium">{t('drift.colDetected')}</th>
                    <th className="px-4 py-3 font-medium">{t('common.status')}</th>
                    <th className="px-4 py-3 font-medium">{t('drift.colAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDrift.map((d) => (
                    <tr key={d.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                      <td className="px-4 py-3 text-sm text-primary">{d.ci_name}</td>
                      <td className="px-4 py-3 text-sm font-mono text-secondary">{d.field_path}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="bg-danger/10 border border-danger/25 rounded px-2 py-1">
                            <ValueCell value={d.old_value} />
                          </span>
                          <span className="text-muted">→</span>
                          <span className="bg-success/10 border border-success/25 rounded px-2 py-1">
                            <ValueCell value={d.new_value} />
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {new Date(d.detected_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        {d.acknowledged_at ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-subtle text-secondary">
                            {t('drift.acknowledged')}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning">
                            {t('drift.open')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {!d.acknowledged_at && (
                          <>
                            <button
                              onClick={() => acknowledgeMutation.mutate(d.id)}
                              disabled={acknowledgeMutation.isPending}
                              className="text-xs text-accent hover:text-accent disabled:opacity-50"
                            >
                              {t('drift.acknowledge')}
                            </button>
                            <button
                              onClick={() => resolveMutation.mutate(d.id)}
                              disabled={resolveMutation.isPending}
                              className="ml-3 text-xs text-success hover:text-success disabled:opacity-50"
                            >
                              {t('drift.resolve')}
                            </button>
                            <button
                              onClick={() => ignoreMutation.mutate(d.id)}
                              disabled={ignoreMutation.isPending}
                              className="ml-3 text-xs text-secondary hover:text-secondary disabled:opacity-50"
                            >
                              {t('drift.ignore')}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </>
      ) : (
        <>
          {baselinesLoading ? (
            <div className="text-muted text-sm">{t('common.loading')}</div>
          ) : baselines.length === 0 ? (
            <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
              {t('drift.noBaselines')}
            </div>
          ) : (
            <div className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
                <thead className="border-b border-edge text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('drift.colLabel')}</th>
                    <th className="px-4 py-3 font-medium">{t('cmdb.colCi')}</th>
                    <th className="px-4 py-3 font-medium">{t('drift.colSnapshot')}</th>
                    <th className="px-4 py-3 font-medium">{t('drift.colCaptured')}</th>
                  </tr>
                </thead>
                <tbody>
                  {baselines.map((b) => (
                    <tr key={b.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                      <td className="px-4 py-3 text-sm text-primary">{b.label ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-secondary">{b.ci_name}</td>
                      <td className="px-4 py-3">
                        <code className="text-xs text-secondary font-mono">
                          {JSON.stringify(b.snapshot).slice(0, 100)}
                          {JSON.stringify(b.snapshot).length > 100 ? '…' : ''}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {new Date(b.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </>
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-surface border border-strong rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">{t('drift.captureBaselineTitle')}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">{t('cmdb.colCi')}</label>
                <select
                  value={form.ci_id}
                  onChange={(e) => setForm({ ...form, ci_id: e.target.value })}
                  className={inputCls}
                >
                  <option value="">{t('drift.selectCi')}</option>
                  {cis.map((ci) => (
                    <option key={ci.id} value={ci.id}>
                      {ci.display_name} ({providerLabel(ci.cloud_provider)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">{t('drift.labelOptional')}</label>
                <input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  className={inputCls}
                  placeholder="e.g. prod-2026-08-13"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">
                  {t('drift.snapshotLabel')}
                </label>
                <textarea
                  value={form.snapshot}
                  onChange={(e) => setForm({ ...form, snapshot: e.target.value })}
                  rows={6}
                  className={`${inputCls} font-mono text-xs`}
                  placeholder='{"cpu_count": 4, "memory_gb": 16}'
                />
              </div>
              {formError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-secondary hover:text-primary transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createBaselineMutation.isPending}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('drift.capture')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
