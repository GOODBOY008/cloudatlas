import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Expenses from '../pages/Expenses'
import { setOrgCurrency } from '../lib/format'
import { useOrgStore } from '../store/orgStore'

vi.mock('../lib/api', () => ({
  default: { get: vi.fn() },
  paginatedGet: vi.fn(),
}))

import api, { paginatedGet } from '../lib/api'

describe('Expenses currency', () => {
  afterEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
      setOrgCurrency('USD')
    })
    vi.clearAllMocks()
  })

  it('displays the workspace currency and preserves the line item currency', async () => {
    act(() => {
      useOrgStore.getState().setCurrentOrg({ id: 'org-001', name: 'Acme', slug: 'acme' })
      setOrgCurrency('CNY')
    })
    vi.mocked(api.get).mockImplementation(async (url: string) => ({
      data: { data: url.includes('/summary?') ? { total_cost: 123.45 } : [] },
    }))
    vi.mocked(paginatedGet).mockResolvedValue({
      data: [{ id: '1', date: '2026-10-01', cloud_resource_id: 'i-1', resource_name: 'server', service_name: 'ECS', cloud_region: 'cn-hangzhou', cost: 123.45, currency: 'CNY' }],
      meta: { total: 1, page: 1, per_page: 50, total_pages: 1 },
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><Expenses /></QueryClientProvider>)

    const row = (await screen.findByText('server')).closest('tr')!
    expect(within(row).getByText(/¥123\.45/)).toBeInTheDocument()
    expect(screen.getAllByText(/¥123\.45/).length).toBeGreaterThan(1)

    act(() => setOrgCurrency('USD'))
    expect(screen.getAllByText(/\$123\.45/).length).toBeGreaterThan(0)
    expect(within(row).getByText(/¥123\.45/)).toBeInTheDocument()
  })
})
