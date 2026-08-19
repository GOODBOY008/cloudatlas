import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PaginationBar, { pageWindow } from '../components/PaginationBar'
import { usePagination } from '../lib/hooks/usePagination'
import i18n from '../i18n'
import type { Paginated } from '../types'

type FetchPage = (page: number, perPage: number) => Promise<Paginated<string>>

const page = (total: number, pageNo: number, perPage = 50, data: string[] = []): Paginated<string> => ({
  data,
  meta: { total, page: pageNo, per_page: perPage, total_pages: Math.max(0, Math.ceil(total / perPage)) },
})

function renderBar(props: Partial<Parameters<typeof PaginationBar>[0]> = {}) {
  const utils = render(
    <PaginationBar
      page={2}
      totalPages={3}
      total={120}
      perPage={50}
      onPageChange={vi.fn()}
      onPerPageChange={vi.fn()}
      {...props}
    />,
  )
  const prev = screen.queryByTestId('prev-page') as HTMLButtonElement
  const next = screen.queryByTestId('next-page') as HTMLButtonElement
  return { ...utils, prev, next }
}

describe('pageWindow', () => {
  it('lists every page when few', () => {
    expect(pageWindow(2, 3)).toEqual([1, 2, 3])
    expect(pageWindow(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('windows first/last + current ±2 with ellipsis for many pages', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, '…', 19, 20])
    expect(pageWindow(10, 20)).toEqual([1, 2, '…', 8, 9, 10, 11, 12, '…', 19, 20])
    expect(pageWindow(20, 20)).toEqual([1, 2, '…', 18, 19, 20])
  })
})

describe('PaginationBar', () => {
  beforeEach(() => i18n.changeLanguage('en'))
  afterEach(() => i18n.changeLanguage('en'))

  it('renders the showing range and windowed page buttons', () => {
    renderBar({ page: 2, totalPages: 3, total: 120 })
    expect(screen.getByText('Showing 51–100 of 120')).toBeInTheDocument()
    expect(screen.getByTestId('page-1')).toBeInTheDocument()
    expect(screen.getByTestId('page-2')).toBeInTheDocument()
    expect(screen.getByTestId('page-3')).toBeInTheDocument()
  })

  it('disables prev on page 1 and next on the last page', () => {
    const first = renderBar({ page: 1, totalPages: 3 })
    expect(first.prev.disabled).toBe(true)
    expect(first.next.disabled).toBe(false)
    first.unmount()

    const last = renderBar({ page: 3, totalPages: 3 })
    expect(last.prev.disabled).toBe(false)
    expect(last.next.disabled).toBe(true)
  })

  it('fires page and per-page change callbacks', () => {
    const onPageChange = vi.fn()
    const onPerPageChange = vi.fn()
    renderBar({ page: 2, totalPages: 3, onPageChange, onPerPageChange })

    fireEvent.click(screen.getByTestId('page-3'))
    expect(onPageChange).toHaveBeenCalledWith(3)

    fireEvent.click(screen.getByTestId('prev-page'))
    expect(onPageChange).toHaveBeenCalledWith(1)

    fireEvent.change(screen.getByTestId('per-page-select'), { target: { value: '100' } })
    expect(onPerPageChange).toHaveBeenCalledWith(100)
  })

  it('renders the empty label instead of a range when total is 0', () => {
    renderBar({ page: 1, totalPages: 0, total: 0 })
    expect(screen.getByText('No results')).toBeInTheDocument()
    expect(screen.queryByTestId('prev-page')).not.toBeInTheDocument()
  })

  it('renders shared pagination.* labels in zh', async () => {
    await i18n.changeLanguage('zh')
    renderBar({ page: 2, totalPages: 3, total: 120 })
    expect(screen.getByText('显示 51–100，共 120')).toBeInTheDocument()
    expect(screen.getByText('← 上一页')).toBeInTheDocument()
    expect(screen.getByText('下一页 →')).toBeInTheDocument()
  })
})

describe('usePagination', () => {
  function makeClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
  }

  function setupHook(fetchPage: FetchPage, baseKey: readonly unknown[]) {
    const client = makeClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const hook = renderHook(
      ({ key }: { key: readonly unknown[] }) => usePagination(key, fetchPage),
      { wrapper, initialProps: { key: baseKey } },
    )
    return hook
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts at page 1 and loads it', async () => {
    const fetchPage = vi.fn<FetchPage>().mockResolvedValue(page(120, 1))
    const hook = setupHook(fetchPage, ['x'])
    await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true))
    expect(fetchPage).toHaveBeenCalledWith(1, 50)
    expect(hook.result.current.page).toBe(1)
    expect(hook.result.current.total).toBe(120)
    expect(hook.result.current.totalPages).toBe(3)
  })

  it('setPage loads another page; setPerPage resets to page 1', async () => {
    const fetchPage = vi.fn<FetchPage>().mockResolvedValue(page(120, 1))
    const hook = setupHook(fetchPage, ['x'])
    await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true))

    await act(async () => hook.result.current.setPage(3))
    expect(hook.result.current.page).toBe(3)
    expect(fetchPage).toHaveBeenLastCalledWith(3, 50)

    await act(async () => hook.result.current.setPerPage(100))
    expect(hook.result.current.page).toBe(1)
    expect(hook.result.current.perPage).toBe(100)
    expect(fetchPage).toHaveBeenLastCalledWith(1, 100)
  })

  it('resets to page 1 when the base key (filters) changes', async () => {
    const fetchPage = vi.fn<FetchPage>().mockResolvedValue(page(120, 1))
    const hook = setupHook(fetchPage, ['x', 'filter-a'])
    await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true))

    await act(async () => hook.result.current.setPage(2))
    expect(hook.result.current.page).toBe(2)

    // Filter change arrives as a new base key.
    await act(async () => hook.rerender({ key: ['x', 'filter-b'] }))
    expect(hook.result.current.page).toBe(1)
  })

  it('keeps previous data while the next page loads (placeholderData)', async () => {
    let resolveSecond: (v: Paginated<string>) => void = () => {}
    const first = Promise.resolve(page(120, 1, 50, ['row-1']))
    const second = new Promise<Paginated<string>>((res) => { resolveSecond = res })
    const fetchPage = vi.fn<FetchPage>().mockReturnValueOnce(first).mockReturnValueOnce(second)

    const hook = setupHook(fetchPage, ['x'])
    await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true))
    expect(hook.result.current.rows).toEqual(['row-1'])

    act(() => hook.result.current.setPage(2))
    // Page 2 request in flight; page 1 rows still visible, flagged as placeholder.
    expect(hook.result.current.rows).toEqual(['row-1'])
    expect(hook.result.current.query.isPlaceholderData).toBe(true)

    await act(async () => resolveSecond(page(120, 2, 50, ['row-51'])))
    await waitFor(() => expect(hook.result.current.rows).toEqual(['row-51']))
    expect(fetchPage).toHaveBeenLastCalledWith(2, 50)
  })
})
