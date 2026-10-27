import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api, { cancelJob, listJobs } from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useActiveJobs, useJob } from '../lib/hooks/useJobs'
import { isJobTerminal, type AccountJob, type CloudAccount } from '../types'
import { providerLabel } from '../lib/providers'

interface ImportHistoryRow {
  cloud_account_id: string
  provider: string
  raw_rows: number
  expense_rows: number
  last_import_at: string | null
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

function JobStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const colors: Record<string, string> = {
    pending: 'bg-emphasis text-secondary',
    running: 'bg-accent-soft/60 text-accent',
    succeeded: 'bg-success/10 text-success',
    failed: 'bg-danger/10 text-danger',
    cancelled: 'bg-warning/10 text-warning',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? colors.pending}`}>
      {t(`jobs.status.${status}`, { defaultValue: status })}
    </span>
  )
}

export default function BillingImport() {
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [accountId, setAccountId] = useState('')
  const [days, setDays] = useState(30)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [confirmCancel, setConfirmCancel] = useState(false)

  const { data: accounts = [], isLoading: accountsLoading } = useQuery<CloudAccount[]>({
    queryKey: ['cloud-accounts', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CloudAccount[] }>(`/orgs/${orgId}/cloud-accounts`)
      return res.data ?? []
    },
  })

  const { data: history = [], isLoading } = useQuery<ImportHistoryRow[]>({
    queryKey: ['billing-history', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ImportHistoryRow[] }>(`/orgs/${orgId}/billing/history`)
      return res.data ?? []
    },
  })

  // The submitted job — live progress card target (202 → poll to terminal).
  const { data: job } = useJob(orgId, activeJobId)

  // Active billing jobs gate the submit button per account (spec §5.2).
  const { data: activeJobs = [] } = useActiveJobs(orgId)
  const billingActiveFor = (id: string) =>
    activeJobs.some((j) => j.job_kind === 'billing_import' && j.cloud_account_id === id)
  const submitDisabled = !accountId || billingActiveFor(accountId) || accountsLoading

  // 最近导入任务 (recent billing_import jobs)
  const { data: recentJobs = [] } = useQuery<AccountJob[]>({
    queryKey: ['jobs', 'recent', 'billing_import', orgId],
    enabled: !!orgId,
    queryFn: () => listJobs(orgId!, { kind: 'billing_import', limit: 10 }),
  })

  const importMutation = useMutation({
    mutationFn: (payload: { cloud_account_id: string; days?: number }) =>
      api.post<{ data: AccountJob }>(`/orgs/${orgId}/billing/import`, payload),
    onSuccess: (res) => {
      // 202 + job handle — the progress card takes over from here.
      setActiveJobId(res.data.data.id)
      setError('')
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (err) => {
      const axiosErr = err as { response?: { status?: number; data?: { error?: { message?: string } } } }
      const msg = axiosErr.response?.data?.error?.message
      if (axiosErr.response?.status === 409) {
        setError(t('jobs.conflictBody'))
      } else {
        setError(msg ?? t('billingImport.importFailed'))
      }
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => cancelJob(orgId!, jobId),
    onSuccess: () => setConfirmCancel(false),
    onError: () => {
      setConfirmCancel(false)
      setError(t('billingImport.importFailed'))
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setActiveJobId(null)
    if (!accountId) {
      setError(t('billingImport.selectAccountRequired'))
      return
    }
    importMutation.mutate({ cloud_account_id: accountId, days })
  }

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id.slice(0, 8)

  const jobAccountName = job ? job.account_name ?? accountName(job.cloud_account_id) : ''
  const pct =
    job && job.progress_total && job.progress_total > 0 && job.progress_current !== null
      ? Math.min(100, Math.round((job.progress_current / job.progress_total) * 100))
      : null
  const elapsed =
    job && job.started_at
      ? Math.max(
          0,
          Math.round(
            ((job.completed_at ? new Date(job.completed_at).getTime() : Date.now()) -
              new Date(job.started_at).getTime()) /
              1000,
          ),
        )
      : null

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="page-title">{t('billingImport.title')}</h2>
      </div>

      <div className="bg-surface border border-edge rounded-xl p-5 mb-6">
        <h3 className="text-sm font-semibold text-primary mb-3">{t('billingImport.triggerImport')}</h3>
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <label className="block text-xs font-medium text-secondary mb-1">{t('billingImport.cloudAccount')}</label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm w-full focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">{t('billingImport.selectAccount')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({providerLabel(a.provider)})
                </option>
              ))}
            </select>
          </div>
          <div className="w-[140px]">
            <label className="block text-xs font-medium text-secondary mb-1">
              {t('billingImport.daysLabel')}
            </label>
            <input
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm w-full focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <button
            type="submit"
            disabled={submitDisabled || importMutation.isPending}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {billingActiveFor(accountId) ? t('billingImport.importing') : t('billingImport.runImport')}
          </button>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
            {error}
          </div>
        )}

        {/* ── Live progress card (spec §5.2) ─────────────────────────────── */}
        {job && !isJobTerminal(job) && (
          <div className="mt-4 p-4 rounded-lg bg-accent-soft/40 border border-accent" data-testid="billing-progress-card">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm font-medium text-primary">{t('billingImport.progressTitle')}</p>
                <p className="text-xs text-secondary mt-0.5">
                  {jobAccountName} ·{' '}
                  {phaseLabelKey(job.phase)
                    ? t(phaseLabelKey(job.phase)!)
                    : t('jobs.status.running')}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {elapsed !== null && (
                  <span className="text-xs text-muted font-mono">{elapsed}s</span>
                )}
                {!confirmCancel ? (
                  <button
                    onClick={() => setConfirmCancel(true)}
                    className="px-3 py-1.5 text-xs rounded bg-danger/10 hover:bg-danger/10 text-danger transition-colors"
                  >
                    {t('jobs.cancel')}
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => cancelMutation.mutate(job.id)}
                      disabled={cancelMutation.isPending}
                      className="px-3 py-1.5 text-xs rounded bg-danger-solid hover:bg-danger-solid/90 disabled:opacity-60 text-white"
                    >
                      {t('jobs.cancelConfirm')}
                    </button>
                    <button
                      onClick={() => setConfirmCancel(false)}
                      className="px-3 py-1.5 text-xs rounded text-secondary hover:text-primary"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                )}
              </div>
            </div>
            {pct !== null ? (
              <div className="w-full bg-subtle rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-accent h-full transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : (
              <div className="w-full bg-subtle rounded-full h-2.5 overflow-hidden">
                <div className="bg-accent/60 h-full w-1/3 animate-pulse" />
              </div>
            )}
            {job.progress_total !== null && job.progress_current !== null && (
              <p className="text-xs text-muted mt-1.5 font-mono">
                {job.progress_current.toLocaleString()} / {job.progress_total.toLocaleString()}
              </p>
            )}
          </div>
        )}

        {/* ── Terminal result box — same numbers as the old completed box ── */}
        {job && isJobTerminal(job) && (
          <div
            className={`mt-4 p-3 rounded-lg text-sm ${
              job.status === 'succeeded'
                ? 'bg-success/10 border border-success/25 text-success'
                : job.status === 'cancelled'
                  ? 'bg-warning/10 border border-warning/25 text-warning'
                  : 'bg-danger/10 border border-danger/25 text-danger'
            }`}
            data-testid="billing-result-box"
          >
            <div className="flex items-center gap-2 mb-1">
              <JobStatusBadge status={job.status} />
              <span className="text-xs text-muted">{jobAccountName}</span>
            </div>
            {job.status === 'succeeded' ? (
              <>
                {t('billingImport.importCompleted')} —{' '}
                {t('billingImport.importResult', {
                  count: job.result?.raw_rows_inserted ?? 0,
                  days: job.result?.days_imported ?? 0,
                  provider: providerLabel(job.result?.provider ?? ''),
                })}
              </>
            ) : job.status === 'cancelled' ? (
              t('jobs.cancelled')
            ) : (
              job.error_message ?? t('billingImport.importFailed')
            )}
          </div>
        )}
      </div>

      <div className="bg-surface border border-edge rounded-xl overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-edge">
          <h3 className="text-sm font-semibold text-primary">{t('billingImport.importHistory')}</h3>
        </div>
        {isLoading ? (
          <div className="p-5 text-muted text-sm">{t('common.loading')}</div>
        ) : history.length === 0 ? (
          <div className="p-5 text-center text-muted text-sm">
            {t('billingImport.empty')}
          </div>
        ) : (
          <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
            <thead className="border-b border-edge text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">{t('billingImport.colAccount')}</th>
                <th className="px-4 py-3 font-medium">{t('billingImport.colProvider')}</th>
                <th className="px-4 py-3 font-medium">{t('billingImport.colRawRows')}</th>
                <th className="px-4 py-3 font-medium">{t('billingImport.colExpenseRows')}</th>
                <th className="px-4 py-3 font-medium">{t('billingImport.colLastImport')}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.cloud_account_id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                  <td className="px-4 py-3 text-sm text-primary">{accountName(h.cloud_account_id)}</td>
                  <td className="px-4 py-3 text-sm text-secondary">{providerLabel(h.provider)}</td>
                  <td className="px-4 py-3 text-sm text-secondary">{h.raw_rows.toLocaleString()}</td>
                  <td className="px-4 py-3 text-sm text-secondary">{h.expense_rows.toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {h.last_import_at ? new Date(h.last_import_at).toLocaleString() : t('common.never')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      {/* ── 最近导入任务 (spec §5.2) ───────────────────────────────────────── */}
      <div className="bg-surface border border-edge rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-edge">
          <h3 className="text-sm font-semibold text-primary">{t('billingImport.recentImports')}</h3>
        </div>
        {recentJobs.length === 0 ? (
          <div className="p-5 text-center text-muted text-sm">{t('billingImport.empty')}</div>
        ) : (
          <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
            <thead className="border-b border-edge text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">{t('billingImport.colAccount')}</th>
                <th className="px-4 py-3 font-medium">{t('common.status')}</th>
                <th className="px-4 py-3 font-medium">{t('billingImport.colRawRows')}</th>
                <th className="px-4 py-3 font-medium">{t('billingImport.daysLabel')}</th>
                <th className="px-4 py-3 font-medium">{t('billingImport.colTriggeredBy')}</th>
                <th className="px-4 py-3 font-medium">{t('billingImport.colStarted')}</th>
              </tr>
            </thead>
            <tbody>
              {recentJobs.map((j) => (
                <tr key={j.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                  <td className="px-4 py-3 text-sm text-primary">{j.account_name ?? accountName(j.cloud_account_id)}</td>
                  <td className="px-4 py-3"><JobStatusBadge status={j.status} /></td>
                  <td className="px-4 py-3 text-sm text-secondary">
                    {j.status === 'succeeded' ? (j.result?.raw_rows_inserted ?? 0).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-secondary">
                    {j.params?.days != null ? String(j.params.days) : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-secondary">
                    {j.triggered_by === 'scheduler'
                      ? t('jobs.triggeredBy.scheduler')
                      : t('jobs.triggeredBy.user')}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {j.started_at ? new Date(j.started_at).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  )
}
