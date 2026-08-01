import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import AICenter from '../pages/AICenter'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url.includes('/ai/provider')) {
        return Promise.resolve({ data: { data: { source: 'org' } } })
      }
      if (url.includes('/ai/settings')) {
        return Promise.resolve({
          data: {
            data: {
              assistant_enabled: true,
              smart_recs_enabled: true,
              forecast_enabled: true,
              anomaly_enabled: true,
              rag_enabled: true,
            },
          },
        })
      }
      return Promise.resolve({ data: { data: [] } })
    }),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}))

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AICenter />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('AICenter provider summary', () => {
  beforeEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
    vi.clearAllMocks()
  })

  it('settings tab shows the current AI mode summary (org)', async () => {
    renderPage()
    // Switch to the settings tab (default tab is assistant).
    const settingsBtn = await screen.findByRole('button', { name: /settings|设置/i })
    settingsBtn.click()
    // The summary paragraph appears once provider query resolves.
    expect(await screen.findByText(/Current AI mode: Org config/i)).toBeInTheDocument()
  })
})
