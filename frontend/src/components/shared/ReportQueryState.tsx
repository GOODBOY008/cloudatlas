import { Button } from '@cloudflare/kumo/components/button'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface QueryState {
  isPending: boolean
  isError: boolean
  isFetching: boolean
  refetch: () => unknown
}

/** Keep failures distinct from successful empty data and healthy status badges. */
export function ReportQueryState({
  query,
  children,
  errorMessage,
  loadingPlaceholder,
}: {
  query: QueryState
  children: ReactNode
  errorMessage?: string
  loadingPlaceholder?: ReactNode
}) {
  const { t } = useTranslation()
  if (query.isPending) {
    return loadingPlaceholder ?? (
      <div className="p-5" role="status" aria-label={t('common.loading')}>
        <div className="skeleton h-24" />
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="space-y-3 p-5" role="alert">
        <p className="text-xs text-warning">{errorMessage ?? t('dashboard.sectionLoadFailed')}</p>
        <Button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? t('common.loading') : t('dashboard.retry')}
        </Button>
      </div>
    )
  }
  return <>{children}</>
}
