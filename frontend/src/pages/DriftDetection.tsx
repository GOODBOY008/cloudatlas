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
  if (value === null || value === undefined) return <span className="text-gray-600">null</span>
  if (typeof value === 'object') {
    return (
      <code className="text-xs text-gray-400 font-mono">
        {JSON.stringify(value).slice(0, 80)}
        {JSON.stringify(value).length > 80 ? '…' : ''}
      </code>
    )
  }
  return <span className="text-gray-300">{String(value)}</span>
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
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('drift.title')}</h2>
        <button
          onClick={() => {
            setShowModal(true)
            setFormError('')
          }}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {t('drift.captureBaseline')}
        </button>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-800">
        {(['drift', 'baselines'] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === tabKey
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
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
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {s === 'all' ? t('drift.filterAll') : s === 'open' ? t('drift.filterOpen') : t('drift.filterAcknowledged')}
              </button>
            ))}
          </div>

          {isError && (
            <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
              {t('drift.loadFailed')}
            </div>
          )}

          {isLoading ? (
            <div className="text-gray-500 text-sm">{t('common.loading')}</div>
          ) : visibleDrift.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
              {drift.length === 0
                ? t('drift.empty')
                : t('drift.noMatchFilter')}
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
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
                    <tr key={d.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                      <td className="px-4 py-3 text-sm text-white">{d.ci_name}</td>
                      <td className="px-4 py-3 text-sm font-mono text-gray-300">{d.field_path}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="bg-red-900/30 border border-red-800 rounded px-2 py-1">
                            <ValueCell value={d.old_value} />
                          </span>
                          <span className="text-gray-600">→</span>
                          <span className="bg-green-900/30 border border-green-800 rounded px-2 py-1">
                            <ValueCell value={d.new_value} />
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(d.detected_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        {d.acknowledged_at ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400">
                            {t('drift.acknowledged')}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-900/40 text-yellow-300">
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
                              className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                            >
                              {t('drift.acknowledge')}
                            </button>
                            <button
                              onClick={() => resolveMutation.mutate(d.id)}
                              disabled={resolveMutation.isPending}
                              className="ml-3 text-xs text-green-400 hover:text-green-300 disabled:opacity-50"
                            >
                              {t('drift.resolve')}
                            </button>
                            <button
                              onClick={() => ignoreMutation.mutate(d.id)}
                              disabled={ignoreMutation.isPending}
                              className="ml-3 text-xs text-gray-400 hover:text-gray-300 disabled:opacity-50"
                            >
                              {t('drift.ignore')}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          {baselinesLoading ? (
            <div className="text-gray-500 text-sm">{t('common.loading')}</div>
          ) : baselines.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
              {t('drift.noBaselines')}
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('drift.colLabel')}</th>
                    <th className="px-4 py-3 font-medium">{t('cmdb.colCi')}</th>
                    <th className="px-4 py-3 font-medium">{t('drift.colSnapshot')}</th>
                    <th className="px-4 py-3 font-medium">{t('drift.colCaptured')}</th>
                  </tr>
                </thead>
                <tbody>
                  {baselines.map((b) => (
                    <tr key={b.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                      <td className="px-4 py-3 text-sm text-white">{b.label ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-300">{b.ci_name}</td>
                      <td className="px-4 py-3">
                        <code className="text-xs text-gray-400 font-mono">
                          {JSON.stringify(b.snapshot).slice(0, 100)}
                          {JSON.stringify(b.snapshot).length > 100 ? '…' : ''}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(b.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">{t('drift.captureBaselineTitle')}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('cmdb.colCi')}</label>
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
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('drift.labelOptional')}</label>
                <input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  className={inputCls}
                  placeholder="e.g. prod-2026-08-13"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
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
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createBaselineMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
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
