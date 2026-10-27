import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface AlertEvent {
  id: string
  budget_alert_id: string | null
  budget_id: string | null
  pool_id: string | null
  alert_type: 'absolute' | 'percentage'
  threshold: number
  actual_value: number
  message: string
  acknowledged_at: string | null
  created_at: string
}

const formatMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

export default function AlertEvents() {
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [typeFilter, setTypeFilter] = useState<'all' | 'absolute' | 'percentage'>('all')

  const { data: events = [], isLoading, isError } = useQuery<AlertEvent[]>({
    queryKey: ['alert-events', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AlertEvent[] }>(`/orgs/${orgId}/alert-events`)
      return res.data ?? []
    },
  })

  const visible = events.filter((e) => typeFilter === 'all' || e.alert_type === typeFilter)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="page-title">{t('alertEvents.title')}</h2>
      </div>

      <div className="flex items-center gap-2 mb-4">
        {(['all', 'absolute', 'percentage'] as const).map((type) => (
          <button
            key={type}
            onClick={() => setTypeFilter(type)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              typeFilter === type
                ? 'bg-accent text-on-accent'
                : 'bg-subtle text-secondary hover:text-primary'
            }`}
          >
            {type === 'all' ? t('alertEvents.filterAll') : type === 'absolute' ? t('alertEvents.filterAbsolute') : t('alertEvents.filterPercentage')}
          </button>
        ))}
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('alertEvents.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : visible.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {events.length === 0
            ? t('alertEvents.empty')
            : t('alertEvents.noMatchFilter')}
        </div>
      ) : (
        <div className="bg-surface border border-edge rounded-xl overflow-hidden">
          <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
            <thead className="border-b border-edge text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">{t('common.type')}</th>
                <th className="px-4 py-3 font-medium">{t('alertEvents.colThreshold')}</th>
                <th className="px-4 py-3 font-medium">{t('alertEvents.colActual')}</th>
                <th className="px-4 py-3 font-medium">{t('alertEvents.colMessage')}</th>
                <th className="px-4 py-3 font-medium">{t('common.status')}</th>
                <th className="px-4 py-3 font-medium">{t('alertEvents.colTriggered')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((ev) => (
                <tr key={ev.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        ev.alert_type === 'absolute'
                          ? 'bg-info/10 text-info'
                          : 'bg-violet/10 text-violet'
                      }`}
                    >
                      {t(`status.${ev.alert_type}`, { defaultValue: ev.alert_type })}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-secondary">
                    {ev.alert_type === 'percentage'
                      ? `${ev.threshold.toFixed(1)}%`
                      : formatMoney(ev.threshold)}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-danger">
                    {ev.alert_type === 'percentage'
                      ? `${ev.actual_value.toFixed(1)}%`
                      : formatMoney(ev.actual_value)}
                  </td>
                  <td className="px-4 py-3 text-sm text-secondary max-w-[360px]">{ev.message}</td>
                  <td className="px-4 py-3">
                    {ev.acknowledged_at ? (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-subtle text-secondary">
                        {t('alertEvents.acknowledged')}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-danger/10 text-danger">
                        {t('alertEvents.fired')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {new Date(ev.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
    </div>
  )
}
