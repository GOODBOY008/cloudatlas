import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Cloud, RefreshCw } from 'lucide-react'
import { listJobs } from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useActiveJobs } from '../lib/hooks/useJobs'
import type { AccountJob } from '../types'

const STATUS_DOT: Record<string, string> = {
  succeeded: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-yellow-500',
}

function phaseLabelKey(phase: string | null): string | null {
  if (!phase) return null
  const map: Record<string, string> = {
    discovering: 'jobs.phase.discovering',
    upserting: 'jobs.phase.upserting',
    k8s_clusters: 'jobs.phase.k8sClusters',
    finalizing: 'jobs.phase.finalizing',
    fetching: 'jobs.phase.fetching',
    importing: 'jobs.phase.importing',
    aggregating: 'jobs.phase.aggregating',
  }
  return map[phase] ?? null
}

/**
 * Global background-jobs indicator in the layout header (spec §5.4):
 * count badge of active jobs, dropdown with each running job (account,
 * kind, phase, n/m mini bar) plus the 5 most recent terminal jobs.
 * Hidden entirely when no jobs have ever run.
 */
export default function BackgroundJobsIndicator() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const { data: activeJobs = [] } = useActiveJobs(orgId)

  // Any-job-history — decides whether the icon shows at all; refresh while
  // the dropdown is open so terminal rows appear live.
  const { data: recentJobs = [] } = useQuery<AccountJob[]>({
    queryKey: ['jobs', 'recent-all', orgId],
    enabled: !!orgId,
    queryFn: () => listJobs(orgId!, { limit: 20 }),
    refetchInterval: open ? 5000 : (q) => (q.state.data?.length ? 15000 : false),
  })
  const recentTerminal = recentJobs.filter((j) =>
    ['succeeded', 'failed', 'cancelled'].includes(j.status),
  )

  // Close on outside click (same pattern as NotificationBell).
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // Hidden entirely when no jobs have run yet; once jobs exist the icon stays
  // visible for discoverability (empty state = no badge).
  const anyJobsEver = activeJobs.length > 0 || recentJobs.length > 0
  if (!anyJobsEver && !open) return null

  function goTo(job: AccountJob) {
    setOpen(false)
    navigate(job.job_kind === 'billing_import' ? '/billing-import' : '/cloud-accounts')
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('jobs.activeJobs')}
        data-testid="background-jobs-indicator"
        className="relative w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
      >
        <RefreshCw size={18} className={activeJobs.length > 0 ? 'animate-spin' : ''} />
        {activeJobs.length > 0 && (
          <span
            data-testid="background-jobs-count"
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-indigo-500 text-white text-[10px] font-bold"
          >
            {activeJobs.length > 9 ? '9+' : activeJobs.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-[340px] max-w-[90vw] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-gray-800">
            <span className="text-sm font-semibold text-white">{t('jobs.activeJobs')}</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {activeJobs.length === 0 && recentTerminal.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-gray-500">
                {t('notifications.empty')}
              </div>
            )}
            {activeJobs.map((job) => {
              const pct =
                job.progress_total && job.progress_total > 0 && job.progress_current !== null
                  ? Math.min(100, Math.round((job.progress_current / job.progress_total) * 100))
                  : null
              return (
                <button
                  key={job.id}
                  onClick={() => goTo(job)}
                  className="w-full text-left px-4 py-3 border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Cloud size={13} className="text-indigo-400 shrink-0" />
                    <span className="text-sm text-white truncate">
                      {job.account_name ?? job.cloud_account_id.slice(0, 8)}
                    </span>
                    <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-900/60 text-indigo-300 shrink-0">
                      {job.job_kind === 'billing_import'
                        ? t('jobs.kind.billingImport')
                        : t('jobs.kind.discovery')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      {pct !== null ? (
                        <div className="bg-indigo-500 h-full" style={{ width: `${pct}%` }} />
                      ) : (
                        <div className="bg-indigo-500/60 h-full w-1/3 animate-pulse" />
                      )}
                    </div>
                    <span className="text-[10px] text-gray-400 font-mono shrink-0">
                      {job.progress_current !== null && job.progress_total !== null
                        ? `${job.progress_current}/${job.progress_total}`
                        : (phaseLabelKey(job.phase) ? t(phaseLabelKey(job.phase)!) : t('jobs.status.running'))}
                    </span>
                  </div>
                </button>
              )
            })}
            {recentTerminal.slice(0, 5).map((job) => (
              <button
                key={job.id}
                onClick={() => goTo(job)}
                className="w-full text-left px-4 py-2.5 border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[job.status] ?? 'bg-gray-500'}`} />
                  <span className="text-xs text-gray-300 truncate">
                    {job.account_name ?? job.cloud_account_id.slice(0, 8)}
                  </span>
                  <span className="text-[10px] text-gray-600 shrink-0">
                    {job.job_kind === 'billing_import'
                      ? t('jobs.kind.billingImport')
                      : t('jobs.kind.discovery')}
                  </span>
                  <span className="ml-auto text-[10px] text-gray-500 shrink-0">
                    {job.completed_at ? new Date(job.completed_at).toLocaleTimeString() : ''}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
