import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, ArrowUpRight, BookOpen, RefreshCw } from 'lucide-react'
import api from '../lib/api'
import { fmtMoney } from '../lib/format'
import { useOrgStore } from '../store/orgStore'
import DataFlowDiagram from '../components/DataFlowDiagram'
import type { DataFlowJob, DataFlowReport } from '../types'

function JobState({ job, to }: { job: DataFlowJob | null; to: string }) {
  const { t, i18n } = useTranslation()
  const tone = job?.status === 'failed' ? 'text-danger' : job?.status === 'succeeded' ? 'text-success' : 'text-muted'
  return <div className="text-xs">
    <Link to={to} className={`font-medium hover:underline ${tone}`}>{job ? t(`jobs.status.${job.status}`) : t('flow.notRun')}</Link>
    {job && <p className="mt-1 text-muted">{new Date(job.completed_at ?? job.created_at).toLocaleString(i18n.language)}</p>}
    {job?.error_message && <p className="mt-1 max-w-xs break-words text-danger">{job.error_message}</p>}
  </div>
}

export default function DataFlow() {
  const { t, i18n } = useTranslation()
  const orgId = useOrgStore((state) => state.currentOrg?.id)
  const { data, isPending, isError, isFetching, refetch } = useQuery<DataFlowReport>({
    queryKey: ['data-flow', orgId], enabled: !!orgId,
    queryFn: async () => (await api.get<{ data: DataFlowReport }>(`/orgs/${orgId}/data-flow`)).data.data,
    refetchInterval: 15000,
  })
  if (!orgId) return <div className="empty-state panel">{t('showback.noOrg')}</div>
  const accounts = data?.accounts ?? []
  const totals = accounts.reduce((sum, account) => ({
    resources: sum.resources + account.resources, linked: sum.linked + account.linked_resources,
    unmatched: sum.unmatched + account.unmatched_rows, unallocated: sum.unallocated + account.unallocated_cost,
    mismatched: sum.mismatched + account.currency_mismatch_rows,
    failed: sum.failed + Number(account.discovery_job?.status === 'failed') + Number(account.billing_job?.status === 'failed'),
  }), { resources: 0, linked: 0, unmatched: 0, unallocated: 0, mismatched: 0, failed: 0 })
  const metrics = [
    { label: 'flow.coverage', value: totals.resources ? `${(100 * totals.linked / totals.resources).toFixed(1)}%` : '—', detail: t('flow.linkedCount', { linked: totals.linked, total: totals.resources }) },
    { label: 'flow.unmatched', value: totals.unmatched.toLocaleString(), detail: t('flow.unmatchedHint') },
    { label: 'flow.unallocated', value: fmtMoney(totals.unallocated, data?.currency), detail: t('flow.period') },
    { label: 'flow.failed', value: totals.failed.toString(), detail: t('flow.failedHint') },
  ]
  return <div className="space-y-6">
    <div className="page-header"><div><h1 className="page-title">{t('flow.title')}</h1><p className="page-description">{t('flow.subtitle')}</p></div><div className="flex flex-wrap gap-2">
      <Link to="/help?article=data-flow" className="btn-secondary"><BookOpen size={16} />{t('help.title')}</Link>
      <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary"><RefreshCw size={16} />{t('showback.refresh')}</button>
    </div></div>
    {isError && <div role="alert" className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{t('flow.error')}</div>}
    {data && totals.mismatched > 0 && <div role="alert" className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm text-warning">{t('flow.currencyWarning', { count: totals.mismatched, currency: data.currency })} <Link to="/help?article=finops" className="underline">{t('help.title')}</Link></div>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map((metric) => <section key={metric.label} className="panel p-5"><h2 className="text-sm text-secondary">{t(metric.label)}</h2>{isPending ? <div className="skeleton my-3 h-8 w-24" /> : <p className="my-2 text-2xl font-semibold text-primary">{data ? metric.value : '—'}</p>}<p className="text-xs leading-5 text-muted">{metric.detail}</p></section>)}</div>
    <section className="panel p-5"><div className="panel-heading"><div><h2 className="panel-title">{t('flow.pipeline')}</h2><p className="panel-caption">{t('flow.pipelineHint')}</p></div><Activity size={20} className="text-accent" aria-hidden="true" /></div><DataFlowDiagram /></section>
    <section className="panel overflow-hidden">
      <div className="panel-heading p-5"><div><h2 className="panel-title">{t('flow.accounts')}</h2><p className="panel-caption">{data ? t('flow.asOf', { time: new Date(data.as_of).toLocaleString(i18n.language) }) : t('flow.period')}</p></div><Link className="text-link text-sm" to="/cloud-accounts">{t('nav.cloudAccounts')} <ArrowUpRight size={14} className="inline" /></Link></div>
      {isPending ? <div className="space-y-3 p-5" role="status" aria-label={t('common.loading')}><div className="skeleton h-12" /><div className="skeleton h-12" /></div> : accounts.length === 0 && !isError ? <div className="empty-state"><p>{t('flow.empty')}</p><Link to="/cloud-accounts" className="btn-primary mt-4">{t('nav.cloudAccounts')}</Link></div> : <div className="table-scroll" tabIndex={0}>
        <table className="w-full min-w-[1080px] text-left text-sm">
          <thead><tr className="border-y border-edge bg-subtle text-xs text-muted">{['account', 'inventory', 'billing', 'costs', 'discovery', 'import'].map((key) => <th key={key} scope="col" className="px-5 py-3 font-medium">{t(`flow.column.${key}`)}</th>)}</tr></thead>
          <tbody>{accounts.map((account) => <tr key={account.id} className="border-b border-edge last:border-0">
            <td className="px-5 py-4 align-top"><p className="font-semibold text-primary">{account.name}</p><p className="mt-1 text-xs text-muted">{account.provider}{!account.is_active && ` · ${t('flow.disabled')}`}</p></td>
            <td className="px-5 py-4 align-top"><Link to="/cmdb" className="text-link">{t('flow.cisCount', { count: account.cis })}</Link><p className="mt-1 text-xs text-muted">{t('flow.linkedCount', { linked: account.linked_resources, total: account.resources })}</p></td>
            <td className="px-5 py-4 align-top"><p>{t('flow.rows', { raw: account.raw_rows, daily: account.expense_rows })}</p><p className="mt-1 text-xs text-muted">{t('flow.latestBill', { date: account.latest_expense_date ?? '—' })}</p></td>
            <td className="px-5 py-4 align-top"><p className="font-medium text-primary">{fmtMoney(account.total_cost, data?.currency)}</p><p className={`mt-1 text-xs ${account.unmatched_rows ? 'text-warning' : 'text-muted'}`}>{t('flow.unmatchedCost', { cost: fmtMoney(account.unmatched_cost, data?.currency) })}</p><p className="mt-1 text-xs text-muted">{t('flow.poolGap', { cost: fmtMoney(account.unallocated_cost, data?.currency) })}</p></td>
            <td className="px-5 py-4 align-top"><JobState job={account.discovery_job} to="/cloud-accounts" /></td>
            <td className="px-5 py-4 align-top"><JobState job={account.billing_job} to="/billing-import" /></td>
          </tr>)}</tbody>
        </table>
      </div>}
      <p className="border-t border-edge px-5 py-4 text-xs leading-5 text-muted">{t('flow.scope')}</p>
    </section>
  </div>
}
