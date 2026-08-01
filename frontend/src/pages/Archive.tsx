import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface ArchivedRec { id: string; rec_type: string; saving: number; resource_id: string; status: string; created_at: string; dismissed_at?: string }
interface AlertEvent { id: string; alert_id: string; alert_name: string; triggered_at: string; cost: number; message: string }

function fmt(v: number) { return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }

export default function Archive() {
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'recommendations' | 'alerts'>('recommendations')

  const { data: archivedRecs, isLoading: recLoading } = useQuery({
    queryKey: ['archived-recs', orgId],
    queryFn: () => api.get<{ data: ArchivedRec[] }>(`/orgs/${orgId}/recommendations?status=archived&limit=100`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const { data: alertEvents, isLoading: evLoading } = useQuery({
    queryKey: ['alert-events', orgId],
    queryFn: () => api.get<{ data: AlertEvent[] }>(`/orgs/${orgId}/alert-events?limit=100`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const reactivate = useMutation({
    mutationFn: (id: string) => api.post(`/orgs/${orgId}/recommendations/${id}/reactivate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['archived-recs', orgId] }),
  })

  const recs = archivedRecs ?? []
  const events = alertEvents ?? []

  const totalArchivedSavings = recs.reduce((s, r) => s + (r.saving ?? 0), 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">{t('archive.title')}</h1>
        <p className="text-sm text-gray-400 mt-1">{t('archive.subtitle')}</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('archive.archivedRecommendations')}</p>
          <p className="text-2xl font-bold text-gray-300 mt-1">{recs.length}</p>
          <p className="text-xs text-gray-500 mt-1">{t('archive.deferredSavings', { amount: fmt(totalArchivedSavings) })}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('archive.alertEvents')}</p>
          <p className="text-2xl font-bold text-gray-300 mt-1">{events.length}</p>
          <p className="text-xs text-gray-500 mt-1">{t('archive.historicalTriggers')}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('archive.reactivatable')}</p>
          <p className="text-2xl font-bold text-indigo-300 mt-1">{recs.filter(r => r.status === 'archived').length}</p>
          <p className="text-xs text-gray-500 mt-1">{t('archive.recommendations')}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-700">
        {([
          { key: 'recommendations', label: t('archive.tabRecommendations', { count: recs.length }) },
          { key: 'alerts', label: t('archive.tabAlertHistory', { count: events.length }) },
        ] as const).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${activeTab === tab.key ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'recommendations' && (
        <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-700">
              {['common.type', 'archive.colResource', 'archive.colSavingPerMonth', 'common.status', 'archive.colArchived', 'common.actions'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">{t(h)}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              {recLoading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">{t('common.loading')}</td></tr>
              ) : recs.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">{t('archive.noArchivedRecs')}</td></tr>
              ) : recs.map(r => (
                <tr key={r.id} className="hover:bg-gray-800">
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded text-xs">{t(`archive.recType.${r.rec_type}`, { defaultValue: r.rec_type })}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-300 font-mono text-xs">{r.resource_id?.slice(0, 24)}…</td>
                  <td className="px-4 py-3 text-green-400 font-semibold">{fmt(r.saving ?? 0)}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 bg-gray-700 text-gray-400 rounded-full text-xs">{t(`status.${r.status}`, { defaultValue: r.status })}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{r.created_at?.slice(0, 10)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => reactivate.mutate(r.id)}
                      disabled={reactivate.isPending}
                      className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                    >
                      {t('archive.restore')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'alerts' && (
        <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-700">
              {['archive.colAlert', 'archive.colTriggeredAt', 'archive.colCostAtTrigger', 'archive.colMessage'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">{t(h)}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              {evLoading ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-gray-500">{t('common.loading')}</td></tr>
              ) : events.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-gray-500">{t('archive.noAlertEvents')}</td></tr>
              ) : events.map(e => (
                <tr key={e.id} className="hover:bg-gray-800">
                  <td className="px-4 py-3 font-medium text-white">{e.alert_name ?? t('archive.alert')}</td>
                  <td className="px-4 py-3 text-gray-400">{e.triggered_at?.slice(0, 16)}</td>
                  <td className="px-4 py-3 text-red-300 font-semibold">{fmt(e.cost ?? 0)}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{e.message ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
