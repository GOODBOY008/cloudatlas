import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Resources from '../pages/Resources'
import { useOrgStore } from '../store/orgStore'
import type { Organization, Paginated } from '../types'

vi.mock('../lib/api', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
  paginatedGet: vi.fn(),
}))

import * as apiModule from '../lib/api'
const paginatedGet = vi.mocked(apiModule.paginatedGet)

const org: Organization = { id: 'org-001', name: 'Acme', slug: 'acme' }

// StrictMode double-renders — exactly where the original ref-based page reset
// silently dropped its update (caught by the Playwright pagination spec).
describe('Resources page pagination (StrictMode)', () => {
  beforeEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
    vi.clearAllMocks()
  })

  it('returns to page 1 when a filter changes on page 2', async () => {
    paginatedGet.mockImplementation((
      _path: string,
      params: { page?: number; per_page?: number; search?: string } = {},
    ): Promise<Paginated<Record<string, unknown>>> =>
      Promise.resolve({
        data: Array.from({ length: 2 }, (_, i) => ({
          id: `${params.search ?? 'all'}-${params.page}-${i}`,
          cloud_resource_id: `id-${params.page}-${i}`,
          name: `res-${params.page}-${i}`,
          resource_type: 'instance',
          active: true,
          total_cost: 1,
        })),
        meta: {
          total: params.search ? 5 : 45,
          page: params.page ?? 1,
          per_page: params.per_page ?? 50,
          total_pages: params.search ? 1 : 3,
        },
      }))

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <React.StrictMode>
          <Resources />
        </React.StrictMode>
      </QueryClientProvider>,
    )

    // 45 rows at 20/page → 3 pages; navigate to page 2.
    fireEvent.change(await screen.findByTestId('per-page-select'), { target: { value: '20' } })
    await waitFor(() => expect(screen.getByText(/Showing 1–20 of 45/)).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('page-2'))
    await waitFor(() => expect(screen.getByText(/Showing 21–40 of 45/)).toBeInTheDocument())

    // Filter change must land back on page 1 of the filtered set.
    fireEvent.change(screen.getByPlaceholderText('Search by name or resource ID…'), {
      target: { value: 'res-1' },
    })
    await waitFor(() => expect(screen.getByText(/Showing 1–5 of 5/)).toBeInTheDocument())
  })
})
