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
      <button className="btn-secondary" disabled={meta.page <= 1} onClick={() => change(meta.page - 1)}>
        {t('storage.previous')}
      </button>
      <span>
        {meta.page} / {meta.total_pages}
      </span>
      <button
        className="btn-secondary"
        disabled={meta.page >= meta.total_pages}
        onClick={() => change(meta.page + 1)}
      >
        {t('storage.next')}
      </button>
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
          <div className="storage-table-wrap" tabIndex={0} aria-label={t('storage.billEvidence')}>
            <table>
              <thead>
                <tr>
                  {['day', 'source', 'category', 'amount', 'allocation'].map((k) => (
                    <th scope="col" key={k}>
                      {t('storage.' + k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.data.data.map((b) => (
                  <tr key={b.expense_id + ':' + b.seq}>
                    <td>{b.date}</td>
                    <td>
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
                    </td>
                    <td>{t('storage.category.' + b.category)}</td>
                    <td>{fmtMoney(b.cost, b.currency)}</td>
                    <td>{t('storage.alloc.' + b.allocation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager meta={result.data.meta} change={setPage} />
        </>
      )}
    </section>
  )
}
