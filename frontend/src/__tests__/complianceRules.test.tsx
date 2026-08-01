import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Compliance from '../pages/Compliance'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

import api from '../lib/api'

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

const policy = {
  id: 'pol-001',
  name: 'required-tags',
  description: 'Every CI must carry env',
  rules: [{ field: 'tags.env', op: 'exists' }],
  severity: 'high',
  is_active: true,
  created_at: '2026-08-01T00:00:00Z',
}

function mockApi() {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.includes('/compliance-policies')) return Promise.resolve({ data: { data: [policy] } })
    if (url.includes('/compliance/results')) return Promise.resolve({ data: { data: [] } })
    return Promise.resolve({ data: { data: [] } })
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Compliance />
    </QueryClientProvider>
  )
}

describe('Compliance policy rule editor', () => {
  beforeEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
    vi.clearAllMocks()
    mockApi()
  })

  it('creates a policy with serialized rules instead of an empty rules array', async () => {
    renderPage()
    await screen.findByText('required-tags')

    fireEvent.click(screen.getByText('+ New Policy'))
    fireEvent.change(screen.getByPlaceholderText('required-tags'), { target: { value: 'env-policy' } })

    const field = await screen.findByLabelText('Rule 1 field')
    fireEvent.change(field, { target: { value: 'tags.env' } })
    fireEvent.change(screen.getByLabelText('Rule 1 operator'), { target: { value: 'eq' } })
    fireEvent.change(screen.getByLabelText('Rule 1 value'), { target: { value: 'prod' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create Policy' }))

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/orgs/org-001/compliance-policies', {
        name: 'env-policy',
        description: undefined,
        severity: 'medium',
        rules: [{ field: 'tags.env', op: 'eq', value: 'prod' }],
      })
    })
  })

  it('serializes in as an array split on commas and gte/lte as numbers', async () => {
    renderPage()
    await screen.findByText('required-tags')

    fireEvent.click(screen.getByText('+ New Policy'))
    fireEvent.change(screen.getByPlaceholderText('required-tags'), { target: { value: 'sizes' } })

    fireEvent.change(screen.getByLabelText('Rule 1 field'), { target: { value: 'cloud_provider' } })
    fireEvent.change(screen.getByLabelText('Rule 1 operator'), { target: { value: 'in' } })
    fireEvent.change(screen.getByLabelText('Rule 1 value'), { target: { value: 'aws, gcp' } })

    fireEvent.click(screen.getByText('+ Add Rule'))
    fireEvent.change(screen.getByLabelText('Rule 2 field'), { target: { value: 'meta.cpu_count' } })
    fireEvent.change(screen.getByLabelText('Rule 2 operator'), { target: { value: 'gte' } })
    fireEvent.change(screen.getByLabelText('Rule 2 value'), { target: { value: '4' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create Policy' }))

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/orgs/org-001/compliance-policies', {
        name: 'sizes',
        description: undefined,
        severity: 'medium',
        rules: [
          { field: 'cloud_provider', op: 'in', value: ['aws', 'gcp'] },
          { field: 'meta.cpu_count', op: 'gte', value: 4 },
        ],
      })
    })
  })

  it('blocks submit when a rule field is empty', async () => {
    renderPage()
    await screen.findByText('required-tags')

    fireEvent.click(screen.getByText('+ New Policy'))
    fireEvent.change(screen.getByPlaceholderText('required-tags'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Policy' }))

    expect(await screen.findByText('Rule field is required (#1)')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('edits an existing policy via PUT with its rules', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Edit'))

    expect(screen.getByText('Edit Compliance Policy')).toBeInTheDocument()
    expect(screen.getByLabelText('Rule 1 field')).toHaveValue('tags.env')

    fireEvent.click(screen.getByText('+ Add Rule'))
    fireEvent.change(screen.getByLabelText('Rule 2 field'), { target: { value: 'tags.team' } })
    fireEvent.change(screen.getByLabelText('Rule 2 operator'), { target: { value: 'exists' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/orgs/org-001/compliance-policies/pol-001', {
        name: 'required-tags',
        description: 'Every CI must carry env',
        severity: 'high',
        rules: [
          { field: 'tags.env', op: 'exists' },
          { field: 'tags.team', op: 'exists' },
        ],
      })
    })
  })

  it('toggles a policy active state via PUT', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Deactivate'))

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/orgs/org-001/compliance-policies/pol-001', {
        is_active: false,
      })
    })
  })

  it('renders violation chips in the results tab', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.includes('/compliance-policies')) return Promise.resolve({ data: { data: [policy] } })
      if (url.includes('/compliance/results')) {
        return Promise.resolve({
          data: {
            data: [
              {
                id: 'res-1',
                ci_id: 'ci-1',
                ci_name: 'web-01',
                policy_id: 'pol-001',
                policy_name: 'required-tags',
                status: 'non_compliant',
                details: [{ field: 'tags.env', op: 'exists' }],
                checked_at: '2026-08-14T00:00:00Z',
              },
            ],
          },
        })
      }
      return Promise.resolve({ data: { data: [] } })
    })

    renderPage()
    fireEvent.click(await screen.findByText('Results'))

    expect(await screen.findByText('web-01')).toBeInTheDocument()
    expect(screen.getByText('Non-Compliant')).toBeInTheDocument()
    expect(screen.getByText('tags.env exists')).toBeInTheDocument()
  })
})
