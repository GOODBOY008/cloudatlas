import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCheck } from 'lucide-react'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface Notification {
  id: string
  kind: string
  title: string
  body: string
  read_at: string | null
  created_at: string
}

const KIND_COLORS: Record<string, string> = {
  budget_alert: 'bg-danger/10 text-danger',
  anomaly: 'bg-warning/10 text-warning',
  recommendation: 'bg-success/10 text-success',
  webhook: 'bg-info/10 text-info',
  sync: 'bg-info/10 text-info',
  system: 'bg-subtle text-secondary',
}

/** i18n label for a notification kind; raw kind as fallback. */
function kindLabel(t: ReturnType<typeof useTranslation>['t'], kind: string): string {
  const label = t(`notifications.kind.${kind}`, { defaultValue: '' })
  return label || kind
}

export default function NotificationBell() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Poll the inbox: every 30 s closed, 15 s while the panel is open
  // (spec 2026-09-09 §5.5).
  const { data: res } = useQuery<{ data: Notification[]; unread: number }>({
    queryKey: ['notifications', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data } = await api.get<{ data: Notification[]; unread: number }>(
        `/orgs/${orgId}/notifications`,
      )
      return data
    },
    refetchInterval: open ? 15000 : 30000,
  })
  const notifications = res?.data ?? []
  const unread = res?.unread ?? 0

  // Close on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function markAllRead() {
    if (!orgId) return
    try {
      await api.post(`/orgs/${orgId}/notifications/read-all`)
      queryClient.invalidateQueries({ queryKey: ['notifications', orgId] })
    } catch {
      /* ignore */
    }
  }

  async function markRead(id: string) {
    if (!orgId) return
    try {
      await api.patch(`/orgs/${orgId}/notifications/${id}/read`)
      queryClient.invalidateQueries({ queryKey: ['notifications', orgId] })
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('notifications.title')}
        aria-label={t('notifications.title')}
        aria-expanded={open}
        className="icon-button relative"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-danger-solid text-white text-[10px] font-bold">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed right-4 top-16 w-[360px] max-w-[calc(100vw-2rem)] bg-surface border border-edge rounded-xl shadow-popover overflow-hidden z-50 sm:absolute sm:right-0 sm:top-11">
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
            <span className="text-sm font-semibold text-primary">{t('notifications.title')}</span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-accent hover:text-accent"
              >
                <CheckCheck size={14} /> {t('notifications.markAllRead')}
              </button>
            )}
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted">
                {t('notifications.empty')}
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => !n.read_at && markRead(n.id)}
                  className={`w-full text-left px-4 py-3 border-b border-edge last:border-0 hover:bg-subtle/50 transition-colors ${
                    n.read_at ? 'opacity-60' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${KIND_COLORS[n.kind] ?? KIND_COLORS.system}`}>
                      {kindLabel(t, n.kind)}
                    </span>
                    {!n.read_at && <span className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <p className="text-sm text-primary mt-1">{n.title}</p>
                  <p className="text-xs text-secondary mt-0.5 line-clamp-2">{n.body}</p>
                  <p className="text-xs text-muted mt-1">{new Date(n.created_at).toLocaleString()}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
