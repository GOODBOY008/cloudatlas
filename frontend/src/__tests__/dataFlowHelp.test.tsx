import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import api from '../lib/api'
import i18n from '../i18n'
import { useOrgStore } from '../store/orgStore'
import HelpCenter from '../pages/HelpCenter'
import DataFlow from '../pages/DataFlow'
import Showback from '../pages/Showback'

vi.mock('../lib/api', () => ({ default: { get: vi.fn() } }))

beforeEach(async () => {
  vi.mocked(api.get).mockReset()
  useOrgStore.setState({ currentOrg: { id: 'flow-org', name: 'Flow', slug: 'flow' } })
  await i18n.changeLanguage('en')
})
function renderPage(page: React.ReactNode, path = '/help') {
  return render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{page}</QueryClientProvider></MemoryRouter>)
}

describe('in-app help', () => {
  it('opens deep-linked articles and searches article body text in both languages', async () => {
    renderPage(<HelpCenter />, '/help?article=allocation')
    expect(screen.getByRole('heading', { level: 2, name: 'Cost allocation and reconciliation' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Showback' })).toHaveAttribute('href', '/showback')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'CUR bucket' } })
    expect(screen.getByRole('heading', { level: 2, name: 'Troubleshooting' })).toBeInTheDocument()
    await act(async () => { await i18n.changeLanguage('zh') })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '多重归属' } })
    expect(screen.getByRole('heading', { level: 2, name: '成本分摊与对账' })).toBeInTheDocument()
  })

  it('recovers from unknown articles and empty searches without fetching an API', () => {
    renderPage(<HelpCenter />, '/help?article=unknown')
    expect(screen.getByRole('heading', { level: 2, name: 'Get started' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no-matching-text-123' } })
    expect(screen.getByRole('heading', { name: 'No matching guides' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Get started' })).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })
})

describe('data quality and allocation views', () => {
  it('does not represent an empty inventory as 100% coverage', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: { accounts: [], currency: 'CNY', period_days: 30, as_of: '2026-11-03T00:00:00Z' } } })
    renderPage(<DataFlow />)
    await screen.findByText('Connect a cloud account to inspect its data flow.')
    expect(screen.queryByText('100.0%')).not.toBeInTheDocument()
    expect(screen.getByText('CI linkage coverage').closest('section')).toHaveTextContent('—')
    expect(api.get).toHaveBeenCalledWith('/orgs/flow-org/data-flow')
  })

  it('shows a retryable error without fabricating successful metrics', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'))
    renderPage(<DataFlow />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load data flow')
    expect(screen.queryByText('Connect a cloud account to inspect its data flow.')).not.toBeInTheDocument()
    vi.mocked(api.get).mockResolvedValue({ data: { data: { accounts: [], currency: 'CNY', period_days: 30, as_of: '2026-11-03T00:00:00Z' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('formats showback in its report currency and exposes ambiguous ownership', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: {
      period_days: 30, currency: 'CNY', total_cost: 150, unallocated_cost: 50, unallocated_pct: 100 / 3,
      cost_center_unallocated_cost: 50, ambiguous_cost: 50, ambiguous_resources: 1, excluded_currency_rows: 2,
      by_pool: [{ pool_id: 'p', pool_name: 'Platform', pool_description: null, cost: 100, resource_count: 1, allocation_pct: 200 / 3 }],
      by_cost_center: [],
    } } })
    renderPage(<Showback />)
    await screen.findByText('Platform')
    expect(screen.getByText('Total spend').closest('div')).toHaveTextContent(/(?:CN¥|¥)150.00/)
    expect(screen.queryByText('$150.00')).not.toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Allocation rules' })).toHaveAttribute('href', '/help?article=allocation')
  })
})
