import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'
import Webhooks from '../pages/Webhooks'
import DriftDetection from '../pages/DriftDetection'
import Constraints from '../pages/Constraints'
import Checklist from '../pages/Checklist'
import AlertEvents from '../pages/AlertEvents'
import BillingImport from '../pages/BillingImport'
import Events from '../pages/Events'
import TaggingPolicies from '../pages/TaggingPolicies'
import ExternalCMDB from '../pages/ExternalCMDB'
import CITypes from '../pages/CITypes'
import BIExport from '../pages/BIExport'
import Integrations from '../pages/Integrations'
import ObjectStorage from '../pages/ObjectStorage'
import AICenter from '../pages/AICenter'

// Mock the API layer: list endpoints return empty arrays; the checklist
// endpoint returns a completed run with no modules configured.
vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url.includes('/recommendations/checklist')) {
        return Promise.resolve({
          data: {
            run_status: 'completed',
            last_run_at: null,
            last_completed_at: null,
            last_error: null,
            modules_config: {},
            recommendation_counts: { active: 0, dismissed: 0 },
          },
        })
      }
      if (url.endsWith('/object-storage')) {
        return Promise.resolve({ data: {data: {buckets:[],accounts:[],allocation:[],bucket_count:0,unclaimed_count:0,billed_count:0,period_cost:null,currency:'CNY'},meta:{page:1,total_pages:0,total:0,per_page:20}} })
      }
      return Promise.resolve({ data: { data: [] } })
    }),
    post: vi.fn(() => Promise.resolve({ data: { data: {} } })),
    put: vi.fn(() => Promise.resolve({ data: { data: {} } })),
    patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
  paginatedGet: vi.fn(() =>
    Promise.resolve({ data: [], meta: { total: 0, page: 1, per_page: 50, total_pages: 0 } }),
  ),
}))

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

function renderPage(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('page smoke tests', () => {
  beforeEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
  })

  it('Webhooks page renders heading and empty state', async () => {
    renderPage(<Webhooks />)
    expect(await screen.findByText('Webhooks')).toBeInTheDocument()
    expect(await screen.findByText(/No webhooks configured/)).toBeInTheDocument()
  })

  it('Drift Detection page renders heading and tabs', async () => {
    renderPage(<DriftDetection />)
    expect(await screen.findByText('Drift Detection')).toBeInTheDocument()
    expect(await screen.findByText('Baselines')).toBeInTheDocument()
    expect(await screen.findByText(/No drift detected/)).toBeInTheDocument()
  })

  it('Constraints page renders heading and empty state', async () => {
    renderPage(<Constraints />)
    expect(await screen.findByText('Organization Constraints')).toBeInTheDocument()
    expect(await screen.findByText(/No constraints defined/)).toBeInTheDocument()
  })

  it('Checklist page renders adoption score', async () => {
    renderPage(<Checklist />)
    expect(await screen.findByText('Recommendations Checklist')).toBeInTheDocument()
    expect(await screen.findByText('Adoption Score')).toBeInTheDocument()
  })

  it('Alert Events page renders heading and empty state', async () => {
    renderPage(<AlertEvents />)
    expect(await screen.findByText('Alert Events')).toBeInTheDocument()
    expect(await screen.findByText(/No alert events yet/)).toBeInTheDocument()
  })

  it('Billing Import page renders heading and empty history', async () => {
    renderPage(<BillingImport />)
    expect(await screen.findByText('Billing Import')).toBeInTheDocument()
    expect(await screen.findByText(/No imports yet/)).toBeInTheDocument()
  })

  it('Events page renders heading and empty state', async () => {
    renderPage(<Events />)
    expect(await screen.findByText('Events')).toBeInTheDocument()
    expect(await screen.findByText(/No events yet/)).toBeInTheDocument()
  })

  it('Tagging Policies page renders heading and empty state', async () => {
    renderPage(<TaggingPolicies />)
    expect(await screen.findByText('Tagging Policies')).toBeInTheDocument()
    expect(await screen.findByText(/No tagging policies/)).toBeInTheDocument()
  })

  it('External CMDB page renders heading and empty state', async () => {
    renderPage(<ExternalCMDB />)
    expect(await screen.findByText('External CMDB & Discovery')).toBeInTheDocument()
    expect(await screen.findByText(/No external CMDB connections/)).toBeInTheDocument()
  })

  it('CI Types page renders heading and type list empty state', async () => {
    renderPage(<CITypes />)
    expect(await screen.findByText('CI Type Management')).toBeInTheDocument()
    expect(await screen.findByText(/Select a CI type/)).toBeInTheDocument()
  })

  it('BI Export page renders heading and empty state', async () => {
    renderPage(<BIExport />)
    expect(await screen.findByText('BI Export')).toBeInTheDocument()
    expect(await screen.findByText(/No exports configured/)).toBeInTheDocument()
  })

  it('Integrations page renders heading and provider cards', async () => {
    renderPage(<Integrations />)
    expect(await screen.findByText('Integrations')).toBeInTheDocument()
    expect(await screen.findByText(/Add a connection/)).toBeInTheDocument()
    expect(await screen.findByText(/No connections yet/)).toBeInTheDocument()
  })

  it('Object Storage page uses the shared navigation label as its heading', async () => {
    renderPage(<MemoryRouter><ObjectStorage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Object Storage' })).toBeInTheDocument()
  })

  it('AI Center page renders heading and tabs', async () => {
    renderPage(<AICenter />)
    expect(await screen.findByText('AI Center')).toBeInTheDocument()
    expect(await screen.findByText('Assistant')).toBeInTheDocument()
    expect(await screen.findByText('Settings')).toBeInTheDocument()
  })
})
