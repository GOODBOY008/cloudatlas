import { InputGroup } from '@cloudflare/kumo/components/input-group'
import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Database, Search } from 'lucide-react'
import api from '../lib/api'
import { fmtMoney } from '../lib/format'
import { providerLabel } from '../lib/providers'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'
import { BucketDetails } from '../features/object-storage/Details'
import { Bills, Pager } from '../features/object-storage/Billing'
import { failure, type Envelope, type Overview, type Period } from '../features/object-storage/types'
import '../features/object-storage/storage.css'

function initialPeriod(): Period {
  const end = new Date(),
    start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 29)
  return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) }
}
function StorageWorkspace({ org }: { org: Organization }) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const [period, setPeriod] = useState(initialPeriod)
  const [dates, setDates] = useState(period)
  const [account, setAccount] = useState('')
  const [search, setSearch] = useState('')
  const [ownership, setOwnership] = useState('')
  const [billed, setBilled] = useState(false)
  const [page, setPage] = useState(1)
  const [openedBill, setOpenedBill] = useState<{ account: string; kind: string } | null>(null)
  const service = params.get('service') || ''
  const selected = params.get('bucket')
  const scope = ['storage-overview', org.id, period.start_date, period.end_date, account, ownership, billed, service]
  const overview = useQuery<Envelope<Overview>>({
    queryKey: [...scope, search, page],
    // Keep the summary and filter bar in place while refreshing this scope's list.
    placeholderData: (previous, query) => scope.every((part, i) => query?.queryKey[i] === part) ? previous : undefined,
    queryFn: async ({ signal }) =>
      (
        await api.get<Envelope<Overview>>(`/orgs/${org.id}/object-storage`, {
          params: {
            ...period,
            account_id: account || undefined,
            search,
            ownership,
            billed,
            service_id: service || undefined,
            page,
            per_page: 20,
          },
          signal,
        })
      ).data,
  })
  const data = overview.data?.data
  const money = (n: number | null) => (n === null ? t('storage.noBillingShort') : fmtMoney(n, data?.currency))
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { preventScrollReset: true })
  }
  return (
    <div className="storage-workbench">
      <header className="storage-page-head">
        <div>
          <h1 className="page-title">{t('nav.objectStorage')}</h1>
          <p>{t('storage.subtitle')}</p>
        </div>
        <span>
          {t('storage.environment')} · <strong>{org.workspace?.environment || org.name}</strong>
        </span>
      </header>
      <form
        className="storage-toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          setPeriod(dates)
          setPage(1)
          setOpenedBill(null)
        }}
      >
        <label>
          {t('storage.account')}
          <SelectField
            aria-label={t('storage.account')}
            value={account}
            onValueChange={value => {
              setAccount(value)
              setPage(1)
              setOpenedBill(null)
            }}
            items={[
              { value: "", label: t('storage.allAccounts') },
              ...(data?.accounts.map((a) => ({ value: a.id, label: a.name })) ?? []),
            ]}
          />
        </label>
        <label>
          {t('storage.from')}
          <Input
            aria-label={t('storage.from')}
            type="date"
            required
            max={dates.end_date}
            value={dates.start_date}
            onChange={(e) => setDates({ ...dates, start_date: e.target.value })}
          />
        </label>
        <label>
          {t('storage.to')}
          <Input
            aria-label={t('storage.to')}
            type="date"
            required
            min={dates.start_date}
            value={dates.end_date}
            onChange={(e) => setDates({ ...dates, end_date: e.target.value })}
          />
        </label>
        <Button type="submit">{t('storage.applyPeriod')}</Button>
      </form>
      {overview.isPending ? (
        <p role="status">{t('common.loading')}</p>
      ) : overview.isError || !data ? (
        <p role="alert">
          {failure(overview.error, t('storage.failed'))}{' '}
          <button className="storage-link" onClick={() => overview.refetch()}>
            {t('storage.retry')}
          </button>
        </p>
      ) : (
        <>
          <div className="storage-cards">
            <div>
              <span>{t('storage.buckets')}</span>
              <strong>{data.bucket_count}</strong>
            </div>
            <div>
              <span>{t('storage.unclaimed')}</span>
              <strong>{data.unclaimed_count}</strong>
            </div>
            <div>
              <span>
                {t('storage.periodCost')} · {data.currency}
              </span>
              <strong>{money(data.period_cost)}</strong>
            </div>
            <div>
              <span>{t('storage.billed')}</span>
              <strong>
                {data.billed_count} / {data.bucket_count}
              </strong>
            </div>
          </div>
        </>
      )}
      <section className="storage-panel">
        <div className="storage-section-head">
          <h2>
            <Database size={18} />
            {t('storage.ledger')}
          </h2>
          {service && (
            <button
              className="storage-link"
              onClick={() => {
                setParam('service', null)
                setPage(1)
              }}
            >
              {t('storage.clearService')}
            </button>
          )}
        </div>
        <div className="storage-filters">
          <search className="storage-bucket-search">
            <InputGroup label={t('storage.find')}>
              <InputGroup.Addon><Search size={16} aria-hidden="true" /></InputGroup.Addon>
              <InputGroup.Input
                aria-label={t('storage.find')}
                type="search"
                name="search"
                value={search}
                placeholder={t('storage.findPlaceholder')}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
              />
            </InputGroup>
          </search>
          <SelectField
            label={t('storage.ownership')}
            value={ownership}
            onValueChange={value => {
              setOwnership(value)
              setPage(1)
            }}
            items={[
              { value: '', label: t('storage.all') },
              ...['unclaimed', 'owned', 'shared'].map(v => ({ value: v, label: t('storage.alloc.' + v) })),
            ]}
          />
          <label className="storage-checkbox">
            <input
              type="checkbox"
              checked={billed}
              onChange={(e) => {
                setBilled(e.target.checked)
                setPage(1)
              }}
            />
            {t('storage.billedOnly')}
          </label>
        </div>
        {overview.isPlaceholderData && <p role="status" className="px-5 pt-2 text-sm text-muted">{t('common.loading')}</p>}
        {data && overview.data && (
          <div aria-busy={overview.isPlaceholderData}>
            {data.buckets.length === 0 ? (
              <p className="storage-empty">
                {t(data.bucket_count ? 'storage.noMatches' : 'storage.noBuckets')}
              </p>
            ) : (
              <div className="storage-table-wrap" role="region" tabIndex={0} aria-label={t('storage.ledger')}>
                <Table>
                  <Table.Header variant="compact">
                    <Table.Row>
                      {['bucket', 'accountRegion', 'serviceSystem', 'team', 'periodCost'].map((k) => (
                        <th scope="col" key={k}>
                          {t('storage.' + k)}
                        </th>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.buckets.map((b) => (
                      <Table.Row key={b.id}>
                        <th scope="row">
                          <button className="storage-link" onClick={() => setParam('bucket', b.id)}>
                            {b.name}
                          </button>
                        </th>
                        <Table.Cell>
                          {b.account_name}
                          <small>
                            {providerLabel(b.provider)} · {b.region || '—'}
                          </small>
                        </Table.Cell>
                        <Table.Cell>
                          {[...new Set(b.owners.map((o) => o.service_name))].join(' / ') ||
                            t('storage.alloc.unclaimed')}
                          <small>
                            {[...new Set(b.owners.map((o) => o.system_name).filter(Boolean))].join(' / ')}
                          </small>
                        </Table.Cell>
                        <Table.Cell>
                          {[...new Set(b.owners.map((o) => o.team_name).filter(Boolean))].join(' / ') || '—'}
                        </Table.Cell>
                        <Table.Cell>{money(b.cost)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            )}
            <Pager meta={overview.data.meta} change={setPage} />
          </div>
        )}
      </section>
      {data && (
        <section className="storage-panel">
          <div className="storage-section-head">
            <h2>{t('storage.reconcile')}</h2>
            <span>
              {period.start_date} – {period.end_date} · {data.currency}
            </span>
          </div>
          <div className="storage-padding">
            {data.period_cost === null ? (
              <p>{t('storage.noBilling')}</p>
            ) : (
              <>
                <p className="storage-equation">
                  {t('storage.allocated')} <strong>{money(data.allocated_cost)}</strong> +{' '}
                  {t('storage.pendingAllocation')} <strong>{money(data.unallocated_cost)}</strong> ={' '}
                  {t('storage.billTotal')} <strong>{money(data.period_cost)}</strong>
                </p>
                <ul className="storage-records">
                  {data.allocation.map((x) => (
                    <li key={x.cloud_account_id + x.kind}>
                      <button
                        className="storage-link"
                        onClick={() => setOpenedBill({ account: x.cloud_account_id, kind: x.kind })}
                      >
                        {x.account_name} · {t('storage.alloc.' + x.kind)} · {money(x.cost)}{' '}
                        <ArrowRight size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
                {openedBill && (
                  <Bills
                    key={openedBill.account + openedBill.kind + period.start_date + period.end_date}
                    org={org.id}
                    period={period}
                    account={openedBill.account}
                    allocation={openedBill.kind}
                  />
                )}
              </>
            )}
            {data.excluded_currency_rows > 0 && (
              <p>{t('storage.excluded', { count: data.excluded_currency_rows })}</p>
            )}
          </div>
        </section>
      )}
      {selected && data && (
        <BucketDetails
          key={org.id + selected}
          org={org}
          id={selected}
          period={period}
          currency={data.currency}
          canBind={data.can_bind}
          canImport={data.can_import}
          canAllocate={data.can_allocate}
          close={() => setParam('bucket', null)}
        />
      )}
    </div>
  )
}
export default function ObjectStorage() {
  const org = useOrgStore((s) => s.currentOrg)
  const { t } = useTranslation()
  return org ? <StorageWorkspace key={org.id} org={org} /> : <p>{t('dashboard.selectWorkspace')}</p>
}
