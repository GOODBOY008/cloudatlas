import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface EventRecord {
  id: string
  kind: 'alert' | 'webhook'
  title: string
  details: Record<string, unknown>
  created_at: string
}

function KindBadge({ kind }: { kind: string }) {
  const { t } = useTranslation()
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        kind === 'alert'
          ? 'bg-danger/10 text-danger'
          : 'bg-info/10 text-info'
      }`}
    >
      {t(`events.kind.${kind}`, { defaultValue: kind })}
    </span>
  )
}

export default function Events() {
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [kindFilter, setKindFilter] = useState<'all' | 'alert' | 'webhook'>('all')
  const [search, setSearch] = useState('')

  const { data: events = [], isLoading, isError } = useQuery<EventRecord[]>({
    queryKey: ['events', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: EventRecord[] }>(`/orgs/${orgId}/events`)
      return res.data ?? []
    },
  })

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events.filter((e) => {
      if (kindFilter !== 'all' && e.kind !== kindFilter) return false
      if (q && !e.title.toLowerCase().includes(q)) return false
      return true
    })
  }, [events, kindFilter, search])

  const grouped = useMemo(() => {
    const map = new Map<string, EventRecord[]>()
    for (const e of visible) {
      const day = new Date(e.created_at).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
      const list = map.get(day) ?? []
      list.push(e)
      map.set(day, list)
    }
    return [...map.entries()]
  }, [visible])

  const [expandedDay, setExpandedDay] = useState<string | null>(null)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="page-title">{t('events.title')}</h2>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          {(['all', 'alert', 'webhook'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                kindFilter === k
                  ? 'bg-accent text-on-accent'
                  : 'bg-subtle text-secondary hover:text-primary'
              }`}
            >
              {k === 'all' ? t('events.filterAll') : k === 'alert' ? t('events.filterAlerts') : t('events.filterWebhooks')}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('events.searchPlaceholder')}
          className="flex-1 min-w-[200px] bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('events.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : grouped.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {events.length === 0
            ? t('events.empty')
            : t('events.noMatchFilter')}
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([day, list]) => (
            <div key={day} className="bg-surface border border-edge rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedDay(expandedDay === day ? null : day)}
                className="w-full flex items-center justify-between px-5 py-3 hover:bg-subtle/40 transition-colors"
              >
                <span className="text-sm font-semibold text-primary">{day}</span>
                <span className="text-xs text-muted">{t('events.count', { count: list.length })}</span>
              </button>
              {(expandedDay === day || grouped.length <= 3) && (
                <div className="border-t border-edge divide-y divide-edge/60">
                  {list.map((e) => (
                    <div key={e.id} className="px-5 py-3 flex items-start gap-3">
                      <KindBadge kind={e.kind} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-primary truncate">{e.title}</p>
                        <p className="text-xs text-muted font-mono truncate mt-0.5">
                          {JSON.stringify(e.details)}
                        </p>
                      </div>
                      <span className="text-xs text-muted whitespace-nowrap">
                        {new Date(e.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
