import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'
import CloudAccounts from '../pages/CloudAccounts'

// Mock the API layer: the cloud-accounts list returns a mix of accounts so
// the edit modal can exercise the configured-badge and clear paths.
vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url.includes('/cloud-accounts')) {
        return Promise.resolve({
          data: {
            data: [
              { id: 'acct-1', name: 'AWS Prod', provider: 'aws', is_active: true, currency: 'USD', resource_count: 5, last_sync_at: null, has_credentials: true },
              { id: 'acct-2', name: 'Demo', provider: 'other', is_active: true, currency: 'USD', resource_count: 0, last_sync_at: null, has_credentials: false },
            ],
          },
        })
      }
      return Promise.resolve({ data: { data: [] } })
    }),
    post: vi.fn(() => Promise.resolve({ data: { data: {} } })),
    put: vi.fn(() => Promise.resolve({ data: { data: {} } })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}))

import api from '../lib/api'

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useOrgStore.setState({ currentOrg: org, organizations: [org] })
  return render(
    <QueryClientProvider client={qc}>
      <CloudAccounts />
    </QueryClientProvider>,
  )
}

describe('Cloud Accounts credentials', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockClear()
    vi.mocked(api.post).mockClear()
    vi.mocked(api.put).mockClear()
  })

  it('shows credential fields for aws and validates before submit', async () => {
    renderPage()
    await screen.findByText('AWS Prod')
    await userEvent.click(screen.getByRole('button', { name: /add account/i }))
    expect(screen.getByLabelText(/access key id/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/account name/i), 'Test AWS')
    const form = screen.getByLabelText(/access key id/i).closest('form')!
    await userEvent.click(form.querySelector('button[type="submit"]')!)
    expect(screen.getByText(/fill in the credential fields/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('sends typed credentials for aws on submit', async () => {
    renderPage()
    await screen.findByText('AWS Prod')
    await userEvent.click(screen.getByRole('button', { name: /add account/i }))
    await userEvent.type(screen.getByLabelText(/account name/i), 'Test AWS')
    await userEvent.type(screen.getByLabelText(/access key id/i), 'AKIA123')
    await userEvent.type(screen.getByLabelText(/secret access key/i), 's3cr3t')
    const form = screen.getByLabelText(/access key id/i).closest('form')!
    await userEvent.click(form.querySelector('button[type="submit"]')!)
    expect(api.post).toHaveBeenCalledWith(
      '/orgs/org-001/cloud-accounts',
      expect.objectContaining({
        provider: 'aws',
        credentials: { access_key_id: 'AKIA123', secret_access_key: 's3cr3t' },
      }),
    )
  })

  it('hides credential fields and sends empty credentials for other', async () => {
    renderPage()
    await screen.findByText('AWS Prod')
    await userEvent.click(screen.getByRole('button', { name: /add account/i }))
    await userEvent.selectOptions(screen.getByLabelText(/provider/i), 'other')
    expect(screen.queryByLabelText(/access key id/i)).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/account name/i), 'Demo2')
    const form = screen.getByLabelText(/account name/i).closest('form')!
    await userEvent.click(form.querySelector('button[type="submit"]')!)
    expect(api.post).toHaveBeenCalledWith(
      '/orgs/org-001/cloud-accounts',
      expect.objectContaining({ provider: 'other', credentials: {} }),
    )
  })

  it('shows configured badge and clears via __CLEAR__ sentinel', async () => {
    renderPage()
    await screen.findByText('AWS Prod')
    await userEvent.click(screen.getAllByRole('button', { name: /edit/i })[0])
    expect(screen.getByText(/credentials configured/i)).toBeInTheDocument()
    // Save with all-blank credentials → no credentials key in the PUT body
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(api.put).toHaveBeenCalledWith(
      '/orgs/org-001/cloud-accounts/acct-1',
      expect.not.objectContaining({ credentials: expect.anything() }),
    )
    // Reopen and clear
    await userEvent.click(screen.getAllByRole('button', { name: /edit/i })[0])
    await userEvent.click(screen.getByRole('button', { name: /clear credentials/i }))
    await userEvent.click(screen.getByRole('button', { name: /confirm clear/i }))
    expect(api.put).toHaveBeenLastCalledWith(
      '/orgs/org-001/cloud-accounts/acct-1',
      expect.objectContaining({ credentials: '__CLEAR__' }),
    )
  })

  it('shows server/token fields for kubernetes and sends config rates as numbers', async () => {
    renderPage()
    await screen.findByText('AWS Prod')
    await userEvent.click(screen.getByRole('button', { name: /add account/i }))
    await userEvent.selectOptions(screen.getByLabelText(/provider/i), 'kubernetes')
    expect(screen.getByLabelText(/api server url/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/bearer token/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/account name/i), 'k8s-prod')
    await userEvent.type(screen.getByLabelText(/api server url/i), 'https://cluster.example')
    await userEvent.type(screen.getByLabelText(/bearer token/i), 'tok-123')
    await userEvent.type(screen.getByLabelText(/namespace/i), 'prod')
    await userEvent.type(screen.getByLabelText(/cpu cost/i), '0.05')
    const form = screen.getByLabelText(/api server url/i).closest('form')!
    await userEvent.click(form.querySelector('button[type="submit"]')!)
    expect(api.post).toHaveBeenCalledWith(
      '/orgs/org-001/cloud-accounts',
      expect.objectContaining({
        provider: 'kubernetes',
        credentials: { server: 'https://cluster.example', token: 'tok-123' },
        config: expect.objectContaining({ namespace: 'prod', cpu_hourly_cost: 0.05 }),
      }),
    )
  })

  it('rotates credentials through the edit modal', async () => {
    renderPage()
    await screen.findByText('AWS Prod')
    await userEvent.click(screen.getAllByRole('button', { name: /edit/i })[0])
    await userEvent.type(screen.getByLabelText(/access key id/i), 'AKIA456')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(api.put).toHaveBeenLastCalledWith(
      '/orgs/org-001/cloud-accounts/acct-1',
      expect.objectContaining({ credentials: { access_key_id: 'AKIA456' } }),
    )
  })
})
