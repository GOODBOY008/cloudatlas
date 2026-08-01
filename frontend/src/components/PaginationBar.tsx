import { useTranslation } from 'react-i18next'

const PER_PAGE_OPTIONS = [20, 50, 100]

/** Windowed page numbers: first/last plus current ±2, with ellipsis gaps. */
export function pageWindow(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const pages = new Set<number>([1, 2, page - 2, page - 1, page, page + 1, page + 2, totalPages - 1, totalPages])
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b)
  const out: Array<number | '…'> = []
  let prev = 0
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('…')
    out.push(p)
    prev = p
  }
  return out
}

interface PaginationBarProps {
  page: number
  totalPages: number
  total: number
  perPage: number
  onPageChange: (page: number) => void
  onPerPageChange: (perPage: number) => void
}

/**
 * Shared pager for every server-paginated list. Renders "showing X–Y of Z",
 * windowed page numbers, prev/next, and the per-page selector. All labels
 * come from the shared `pagination.*` i18n keys.
 */
export default function PaginationBar({
  page,
  totalPages,
  total,
  perPage,
  onPageChange,
  onPerPageChange,
}: PaginationBarProps) {
  const { t } = useTranslation()

  if (total === 0) {
    return (
      <div className="px-4 py-3 border-t border-gray-700 text-sm text-gray-400">
        {t('pagination.empty')}
      </div>
    )
  }

  const start = (page - 1) * perPage + 1
  const end = Math.min(page * perPage, total)

  return (
    <div className="px-4 py-3 border-t border-gray-700 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-400">
      <span>
        {t('pagination.showing', { start: start.toLocaleString(), end: end.toLocaleString(), total: total.toLocaleString() })}
      </span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span className="text-xs">{t('pagination.perPage')}</span>
          <select
            data-testid="per-page-select"
            value={perPage}
            onChange={(e) => onPerPageChange(Number(e.target.value))}
            className="bg-gray-800 text-gray-200 rounded px-1.5 py-1 text-xs border border-gray-700 focus:outline-none focus:border-indigo-500"
          >
            {PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <button
          data-testid="prev-page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="px-3 py-1 rounded bg-gray-800 disabled:opacity-40 hover:bg-gray-700 transition-colors"
        >
          {t('pagination.prev')}
        </button>
        {pageWindow(page, totalPages).map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="px-1 text-gray-600">…</span>
          ) : (
            <button
              key={p}
              data-testid={`page-${p}`}
              aria-label={t('pagination.pageAria', { page: p })}
              onClick={() => onPageChange(p)}
              className={
                p === page
                  ? 'px-2.5 py-1 rounded bg-indigo-600 text-white font-medium'
                  : 'px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 transition-colors'
              }
            >
              {p}
            </button>
          ),
        )}
        <button
          data-testid="next-page"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="px-3 py-1 rounded bg-gray-800 disabled:opacity-40 hover:bg-gray-700 transition-colors"
        >
          {t('pagination.next')}
        </button>
      </div>
    </div>
  )
}
