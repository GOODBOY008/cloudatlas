import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Resources from '../pages/Resources'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn(),
    patch: vi.fn(),
  },
  paginatedGet: vi.fn(() =>
    Promise.resolve({ data: [], meta: { total: 0, page: 1, per_page: 50, total_pages: 0 } }),
  ),
}))

import api, * as apiModule from '../lib/api'

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

const resource = {
  id: 'res-001',
  cloud_resource_id: 'i-0abc123def4567890',
  name: 'web-prod-01',
  resource_type: 'instance',
  service_name: 'EC2',
  cloud_region: 'us-east-1',
  active: true,
  total_cost: 120.5,
  last_month_cost: 40.2,
  pool_id: null,
  tags: { env: 'prod' },
  first_seen: '2026-01-01T00:00:00Z',
  last_seen: '2026-08-01T00:00:00Z',
  recommendations: [],
}

function mockApi() {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.includes('/raw-expenses')) return Promise.resolve({ data: { data: [] } })
    if (url.includes('/recommendations')) return Promise.resolve({ data: { data: [] } })
    return Promise.resolve({ data: { data: resource } })
  })
  const { paginatedGet } = vi.mocked(apiModule)
  paginatedGet.mockImplementation(() =>
    Promise.resolve({ data: [resource], meta: { total: 1, page: 1, per_page: 50, total_pages: 1 } }),
  )
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Resources />
    </QueryClientProvider>
  )
}

async function openDrawer() {
  renderPage()
  fireEvent.click(await screen.findByText('web-prod-01'))
  await screen.findByText('Tags')
}

describe('Resources detail panel tag editor', () => {
  beforeEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
    vi.clearAllMocks()
    mockApi()
  })

  it('edits tags as key/value rows instead of a raw JSON textarea', async () => {
    await openDrawer()

    // Existing tags render as chips.
    expect(screen.getByText('env: prod')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Edit'))

    // Row editor with key/value inputs — no JSON textarea.
    const editor = await screen.findByTestId('resource-tags-editor')
    expect(editor).toBeInTheDocument()
    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.getByLabelText('Tag 1 key')).toHaveValue('env')
    expect(screen.getByLabelText('Tag 1 value')).toHaveValue('prod')

    // Add a new tag and save.
    fireEvent.click(screen.getByText('+ Add tag'))
    fireEvent.change(screen.getByLabelText('Tag 2 key'), { target: { value: 'team' } })
    fireEvent.change(screen.getByLabelText('Tag 2 value'), { target: { value: 'platform' } })
    fireEvent.click(screen.getByTestId('resource-tags-save'))

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/orgs/org-001/resources/res-001/tags', {
        tags: { env: 'prod', team: 'platform' },
      })
    })
  })

  it('rejects duplicate keys without hitting the API', async () => {
    await openDrawer()
    fireEvent.click(screen.getByText('Edit'))

    fireEvent.click(screen.getByText('+ Add tag'))
    fireEvent.change(screen.getByLabelText('Tag 2 key'), { target: { value: 'env' } })
    fireEvent.change(screen.getByLabelText('Tag 2 value'), { target: { value: 'staging' } })
    fireEvent.click(screen.getByTestId('resource-tags-save'))

    expect(await screen.findByText('Duplicate key "env".')).toBeInTheDocument()
    expect(api.patch).not.toHaveBeenCalled()
  })
})
