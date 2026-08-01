import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface Policy {
  id: string
  name: string
  description?: string
  policy_type: 'ttl' | 'idle_shutdown' | 'tag_based' | 'schedule_based'
  ttl_days?: number
  idle_days?: number
  action: 'flag' | 'notify' | 'decommission' | 'stop'
  is_active: boolean
  last_evaluated_at?: string
  created_at: string
}

interface LifecycleEvent {
  id: string
  policy_name?: string
  cloud_resource_id?: string
  resource_type?: string
  event_type: string
  reason?: string
  actor_name?: string
  created_at: string
}

const actionColors: Record<string, string> = {
  flag:          'bg-blue-900/50 text-blue-300',
  notify:        'bg-indigo-900/50 text-indigo-300',
  decommission:  'bg-red-900/50 text-red-300',
  stop:          'bg-orange-900/50 text-orange-300',
}

const eventColors: Record<string, string> = {
  flagged:        'text-yellow-400',
  notified:       'text-blue-400',
  decommissioned: 'text-red-400',
  stopped:        'text-orange-400',
  exempted:       'text-green-400',
  restored:       'text-emerald-400',
}

export default function ResourceLifecycle() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const qc = useQueryClient()

  const [activeTab, setActiveTab] = useState<'policies' | 'events'>('policies')
  const [showCreate, setShowCreate] = useState(false)
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '', description: '', policy_type: 'ttl', ttl_days: 30, idle_days: 14, action: 'flag',
  })

  const { data: policies, isLoading: policyLoading } = useQuery({
    queryKey: ['lifecycle-policies', orgId],
    queryFn: () => api.get<{ data: Policy[] }>(`/orgs/${orgId}/lifecycle-policies`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const { data: events, isLoading: eventLoading } = useQuery({
    queryKey: ['lifecycle-events', orgId],
    queryFn: () => api.get<{ data: LifecycleEvent[] }>(`/orgs/${orgId}/lifecycle-events`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const createPolicy = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/lifecycle-policies`, {
      name: form.name,
      description: form.description || undefined,
      policy_type: form.policy_type,
      ttl_days: form.policy_type === 'ttl' ? form.ttl_days : undefined,
      idle_days: form.policy_type === 'idle_shutdown' ? form.idle_days : undefined,
      action: form.action,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lifecycle-policies', orgId] }); setShowCreate(false) },
  })

  const deletePolicy = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/lifecycle-policies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lifecycle-policies', orgId] }),
  })

  const evaluatePolicy = useMutation({
    mutationFn: (id: string) => {
      setEvaluatingId(id)
      return api.post<{ flagged_count: number }>(`/orgs/${orgId}/lifecycle-policies/${id}/evaluate`, {})
    },
    onSuccess: (res, _id) => {
      const count = res.data.flagged_count ?? 0
      alert(t('resourceLifecycle.evaluationComplete', { count }))
      setEvaluatingId(null)
      qc.invalidateQueries({ queryKey: ['lifecycle-policies', orgId] })
      qc.invalidateQueries({ queryKey: ['lifecycle-events', orgId] })
    },
    onError: () => setEvaluatingId(null),
  })

  const pols = policies ?? []
  const evts = events ?? []
  const activePolicies = pols.filter(p => p.is_active).length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('resourceLifecycle.title')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t('resourceLifecycle.subtitle')}</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-500">
          {t('resourceLifecycle.newPolicy')}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('resourceLifecycle.totalPolicies')}</p>
          <p className="text-2xl font-bold text-white mt-1">{pols.length}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('common.active')}</p>
          <p className="text-2xl font-bold text-green-400 mt-1">{activePolicies}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('resourceLifecycle.lifecycleEvents')}</p>
          <p className="text-2xl font-bold text-yellow-400 mt-1">{evts.length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-700">
        {([
          { key: 'policies', label: t('resourceLifecycle.tabPolicies', { count: pols.length }) },
          { key: 'events', label: t('resourceLifecycle.tabEvents', { count: evts.length }) },
        ] as const).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${activeTab === tab.key ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'policies' && (
        <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-700">
              {['common.name', 'common.type', 'resourceLifecycle.colThreshold', 'resourceLifecycle.colAction', 'common.active', 'resourceLifecycle.colLastRun', 'common.actions'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">{t(h)}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              {policyLoading ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-500">{t('common.loading')}</td></tr>
              ) : pols.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-500">{t('resourceLifecycle.noPolicies')}</td></tr>
              ) : pols.map(p => (
                <tr key={p.id} className="hover:bg-gray-800">
                  <td className="px-4 py-3">
                    <p className="font-medium text-white">{p.name}</p>
                    {p.description && <p className="text-xs text-gray-500 mt-0.5">{p.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{t(`resourceLifecycle.policyType.${p.policy_type}`, { defaultValue: p.policy_type })}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">
                    {p.policy_type === 'ttl' && p.ttl_days != null ? t('resourceLifecycle.ttlDays', { days: p.ttl_days }) : null}
                    {p.policy_type === 'idle_shutdown' && p.idle_days != null ? t('resourceLifecycle.idleDays', { days: p.idle_days }) : null}
                    {p.policy_type !== 'ttl' && p.policy_type !== 'idle_shutdown' ? '—' : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${actionColors[p.action] ?? ''}`}>{t(`resourceLifecycle.action.${p.action}`, { defaultValue: p.action })}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-semibold ${p.is_active ? 'text-green-400' : 'text-gray-500'}`}>
                      {p.is_active ? t('resourceLifecycle.yes') : t('resourceLifecycle.no')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {p.last_evaluated_at ? new Date(p.last_evaluated_at).toLocaleString() : t('common.never')}
                  </td>
                  <td className="px-4 py-3 flex gap-2">
                    <button onClick={() => evaluatePolicy.mutate(p.id)}
                      disabled={evaluatingId === p.id}
                      className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50">
                      {evaluatingId === p.id ? t('resourceLifecycle.running') : t('resourceLifecycle.run')}
                    </button>
                    <button onClick={() => { if (confirm(t('resourceLifecycle.confirmDelete'))) deletePolicy.mutate(p.id) }}
                      className="text-xs text-red-400 hover:text-red-300">
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'events' && (
        <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-700">
              {['resourceLifecycle.colEvent', 'pools.colResource', 'common.type', 'resourceLifecycle.colPolicy', 'resourceLifecycle.colReason', 'resourceLifecycle.colTime'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">{t(h)}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              {eventLoading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">{t('common.loading')}</td></tr>
              ) : evts.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">{t('resourceLifecycle.noEvents')}</td></tr>
              ) : evts.map(e => (
                <tr key={e.id} className="hover:bg-gray-800">
                  <td className="px-4 py-3">
                    <span className={`font-medium capitalize ${eventColors[e.event_type] ?? 'text-gray-300'}`}>
                      {t(`resourceLifecycle.eventType.${e.event_type}`, { defaultValue: e.event_type })}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">{e.cloud_resource_id?.slice(0, 30) ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{e.resource_type ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{e.policy_name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">{e.reason ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{e.created_at?.slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Policy Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-2xl border border-gray-700 p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-bold text-white">{t('resourceLifecycle.newPolicyTitle')}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('common.name')} *</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
                  placeholder={t('resourceLifecycle.namePlaceholder')} />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('resourceLifecycle.policyType')}</label>
                <select value={form.policy_type} onChange={e => setForm(p => ({ ...p, policy_type: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white">
                  <option value="ttl">{t('resourceLifecycle.typeTtlOption')}</option>
                  <option value="idle_shutdown">{t('resourceLifecycle.typeIdleOption')}</option>
                </select>
              </div>
              {form.policy_type === 'ttl' && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">{t('resourceLifecycle.ttlDaysLabel')}</label>
                  <input type="number" min={1} value={form.ttl_days}
                    onChange={e => setForm(p => ({ ...p, ttl_days: parseInt(e.target.value) || 30 }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
                </div>
              )}
              {form.policy_type === 'idle_shutdown' && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">{t('resourceLifecycle.idleDaysLabel')}</label>
                  <input type="number" min={1} value={form.idle_days}
                    onChange={e => setForm(p => ({ ...p, idle_days: parseInt(e.target.value) || 14 }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('resourceLifecycle.colAction')}</label>
                <select value={form.action} onChange={e => setForm(p => ({ ...p, action: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white">
                  <option value="flag">{t('resourceLifecycle.optionFlag')}</option>
                  <option value="notify">{t('resourceLifecycle.optionNotify')}</option>
                  <option value="stop">{t('resourceLifecycle.optionStop')}</option>
                  <option value="decommission">{t('resourceLifecycle.optionDecommission')}</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowCreate(false)}
                className="flex-1 py-2 text-sm bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600">
                {t('common.cancel')}
              </button>
              <button onClick={() => createPolicy.mutate()}
                disabled={createPolicy.isPending || !form.name.trim()}
                className="flex-1 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50">
                {createPolicy.isPending ? t('resourceLifecycle.creating') : t('resourceLifecycle.createPolicy')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
