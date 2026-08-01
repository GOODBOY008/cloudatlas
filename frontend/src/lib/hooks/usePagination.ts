import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { Paginated } from '../../types'

interface UsePaginationOptions {
  defaultPerPage?: number
  /** Pass the caller's `enabled` (usually `!!orgId`) through to TanStack Query. */
  enabled?: boolean
}

interface UsePaginationResult<T> {
  /** The TanStack Query result for the current page. */
  query: ReturnType<typeof useQuery<Paginated<T>, Error>>
  /** Rows of the current page (empty while loading the first page). */
  rows: T[]
  page: number
  perPage: number
  totalPages: number
  total: number
  setPage: (page: number) => void
  /** Changing the page size always returns to page 1. */
  setPerPage: (perPage: number) => void
}

/**
 * Shared server-pagination state. Owns `page`/`perPage`, resets `page` to 1
 * when the base query key changes (i.e. when filters change), and wires
 * TanStack Query with `placeholderData: keepPreviousData` so page flips
 * don't blank the table.
 *
 * @param queryKey base key WITHOUT page/perPage — include org id and every
 *   active filter so key changes reset the page (e.g. `['cis', orgId, search]`).
 * @param fetchPage callback that loads one page; receives the 1-based page
 *   and the page size, returns the unified `{data, meta}` envelope.
 */
export function usePagination<T>(
  queryKey: readonly unknown[],
  fetchPage: (page: number, perPage: number) => Promise<Paginated<T>>,
  options: UsePaginationOptions = {},
): UsePaginationResult<T> {
  const [page, setPage] = useState(1)
  const [perPage, setPerPageState] = useState(options.defaultPerPage ?? 50)

  // A filter change arrives as a new base key — reset to page 1 before the
  // query fires. Canonical "adjust state when a prop changes" pattern: compare
  // against state (not a ref) so it survives StrictMode's double render.
  const keyStr = JSON.stringify(queryKey)
  const [prevKey, setPrevKey] = useState(keyStr)
  if (prevKey !== keyStr) {
    setPrevKey(keyStr)
    setPage(1)
  }

  const query = useQuery<Paginated<T>, Error>({
    queryKey: [...queryKey, 'page', page, perPage],
    queryFn: () => fetchPage(page, perPage),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  })

  const meta = query.data?.meta
  const total = meta?.total ?? 0
  // totalPages 0 (empty result) still shows page 1 in the bar.
  const totalPages = Math.max(meta?.total_pages ?? 1, 1)

  const setPerPage = (n: number) => {
    setPerPageState(n)
    setPage(1)
  }

  return {
    query,
    rows: query.data?.data ?? [],
    page,
    perPage,
    totalPages,
    total,
    setPage,
    setPerPage,
  }
}
