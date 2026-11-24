import { Table } from '@cloudflare/kumo/components/table'
import { Button } from '@cloudflare/kumo/components/button'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../../lib/api'
import { fmtMoney } from '../../lib/format'
import type { Bill, Envelope, Period } from './types'
import { failure } from './types'
import type { PageMeta } from '../../types'

export function Pager({ meta, change }: { meta: PageMeta; change: (n: number) => void }) {
  const { t } = useTranslation()
  if (meta.total_pages <= 1) return null
  return (
    <div className="storage-pager">
      <Button disabled={meta.page <= 1} onClick={() => change(meta.page - 1)}>
        {t('storage.previous')}
      </Button>
      <span>
        {meta.page} / {meta.total_pages}
      </span>
      <Button
        disabled={meta.page >= meta.total_pages}
        onClick={() => change(meta.page + 1)}
      >
        {t('storage.next')}
      </Button>
    </div>
  )
}
export function Bills({
  org,
  period,
  bucket,
  account,
  allocation,
}: {
  org: string
  period: Period
  bucket?: string
  account?: string
  allocation?: string
}) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const result = useQuery({
    queryKey: ['storage-bills', org, period, bucket, account, allocation, page],
    queryFn: async ({ signal }) =>
      (
        await api.get<Envelope<Bill[]>>(`/orgs/${org}/object-storage/bills`, {
          params: {
            ...period,
            bucket_id: bucket,
            account_id: account || undefined,
            allocation,
            page,
            per_page: 10,
          },
          signal,
        })
      ).data,
  })
  if (result.isPending) return <p role="status">{t('common.loading')}</p>
  if (result.isError) return <p role="alert">{failure(result.error, t('storage.failed'))}</p>
  return (
    <section>
      <h4>{t('storage.billEvidence')}</h4>
      {result.data.data.length === 0 ? (
        <p className="storage-muted">{t('storage.noBilling')}</p>
      ) : (
        <>
          <div
            className="storage-table-wrap"
            role="region"
            tabIndex={0}
            aria-label={t('storage.billEvidence')}
          >
            <Table>
              <Table.Header variant="compact">
                <Table.Row>
                  {['day', 'source', 'category', 'amount', 'allocation'].map((k) => (
                    <th scope="col" key={k}>
                      {t('storage.' + k)}
                    </th>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {result.data.data.map((b) => (
                  <Table.Row key={b.expense_id + ':' + b.seq}>
                    <Table.Cell>{b.date}</Table.Cell>
                    <Table.Cell>
                      <strong>{b.account_name}</strong>
                      <small>{b.cloud_resource_id}</small>
                      <details>
                        <summary>{t('storage.trace')}</summary>
                        <small>
                          {t('storage.ledgerId')} · {b.expense_id}
                        </small>
                        {b.raw_id && (
                          <small>
                            {t('storage.rawId')} · {b.raw_id}
                          </small>
                        )}
                        {b.imported_at && (
                          <small>
                            {t('storage.importedAt')} · {new Date(b.imported_at).toLocaleString()}
                          </small>
                        )}
                        {b.service && (
                          <small>
                            {t('storage.sourceProduct')} · {b.service}
                          </small>
                        )}
                        {b.item && <small>{b.item}</small>}
                        {b.original_cost !== null && (
                          <small>
                            {t('storage.original')} · {b.original_cost} {b.original_currency}
                          </small>
                        )}
                      </details>
                    </Table.Cell>
                    <Table.Cell>{t('storage.category.' + b.category)}</Table.Cell>
                    <Table.Cell>{fmtMoney(b.cost, b.currency)}</Table.Cell>
                    <Table.Cell>{t('storage.alloc.' + b.allocation)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <Pager meta={result.data.meta} change={setPage} />
        </>
      )}
    </section>
  )
}
