import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import AICenter from '../pages/AICenter'
import { useCopilotStore } from '../store/copilotStore'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'

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

describe('AICenter assistant redirect', () => {
  beforeEach(() => {
    act(() => {
      useCopilotStore.getState().setOpen(false)
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
  })

  it('shows the redirect card instead of the legacy chat', () => {
    renderPage()
    expect(screen.getByText('The assistant has moved')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Ask CloudAtlas Copilot/i)).not.toBeInTheDocument()
  })

  it('the Open Copilot button opens the global panel', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Open Copilot' }))
    expect(useCopilotStore.getState().open).toBe(true)
  })
})
