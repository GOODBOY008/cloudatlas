import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Dashboard from '../pages/Dashboard'
import { dashboardPeriods } from '../features/dashboard/useDashboardData'
import { useOrgStore } from '../store/orgStore'

vi.mock('../lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('recharts', () => ({
  ResponsiveContainer: () => null,
  AreaChart: () => null, Area: () => null, XAxis: () => null,
  YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}))
import api from '../lib/api'

function response(url: string) {
  if (url.includes('/expenses/summary')) return { data: { total_cost: 120, resource_count: 3 } }
  if (url.includes('/recommendations/summary')) return { data: { total: 9, open: 7, dismissed: 2 } }
  if (url.includes('/cloud-accounts')) return { data: [{ id: 'account' }] }
  if (url.includes('/pools/tree')) return { data: [{ id: 'pool', name: 'Production', monthly_budget: 100, current_month_spend: 95, budget_used_pct: 95 }] }
  if (url.endsWith('/pools')) return { data: [{ id: 'pool' }] }
  if (url.includes('/expenses/forecast')) return {
    history: [{ date: '2026-11-01', cost: 20 }],
    forecast: [{ date: '2026-11-02', predicted_cost: 20 }, { date: '2026-12-01', predicted_cost: 20 }],
    summary: { projected_monthly: 600, change_percent: 2.5, trend_direction: 'increasing' },
  }
  if (url.includes('/expenses/anomalies')) return { anomalies: [{ cloud_resource_id: 'resource', resource_name: 'Anomalous resource', date: '2026-11-01', z_score: 3 }] }
  return { data: [] }
}

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = render(<QueryClientProvider client={client}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>)
  return { client, ...view }
}

function metric(label: string) {
  return screen.getByRole('button', { name: new RegExp(label) })
}

beforeEach(() => {
  useOrgStore.getState().setCurrentOrg({ id: 'org-a', name: 'Acme', slug: 'acme' })
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: response(url) }))
})

afterEach(() => {
  cleanup()
  useOrgStore.getState().clearOrg()
  vi.resetAllMocks()
})

describe('Dashboard data contracts', () => {
  it('shows real API payloads for active recommendations, forecast, anomalies and pool spend', async () => {
    renderDashboard()
    await screen.findByText('Anomalous resource')
    expect(within(metric('Active Recommendations')).getByText('7')).toBeInTheDocument()
    expect(screen.getByText('$600.00')).toBeInTheDocument()
    expect(screen.getByText('Forecast period: 2026-11-02 – 2026-12-01')).toBeInTheDocument()
    expect(screen.getByText('2.5% estimated daily change')).toBeInTheDocument()
    expect(screen.getByText('$95.00 / $100.00')).toBeInTheDocument()
    expect(screen.queryByText('No Anomalies')).not.toBeInTheDocument()
    expect(within(metric('Billed Resources')).getByText('3')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/expenses\/summary\?start_date=\d{4}-\d{2}-01&end_date=\d{4}-\d{2}-\d{2}/), { signal: expect.any(AbortSignal) })
  })

  it('keeps successful metrics visible and retries unavailable summary data without showing false zeros or onboarding', async () => {
    let fails = true
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (fails && url.includes('/expenses/summary')) throw new Error('Offline')
      return { data: response(url) }
    })
    renderDashboard()
    await screen.findByText('Some overview metrics are unavailable. Available data is shown below.')
    expect(within(metric('Total Cost')).getByText('Unavailable')).toBeInTheDocument()
    expect(within(metric('Active Recommendations')).getByText('7')).toBeInTheDocument()
    expect(screen.queryByText('Welcome to CloudAtlas!')).not.toBeInTheDocument()
    fails = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(within(metric('Total Cost')).getByText('$120.00')).toBeInTheDocument())
    expect(screen.queryByText('Some overview metrics are unavailable. Available data is shown below.')).not.toBeInTheDocument()
  })

  it('never reports healthy anomalies or budgets when those requests fail', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/expenses/anomalies') || url.includes('/pools/tree')) throw new Error('Offline')
      return { data: response(url) }
    })
    renderDashboard()
    await waitFor(() => expect(screen.getAllByText('This data could not be loaded. Retry to get the latest result.')).toHaveLength(2))
    expect(screen.queryByText('No Anomalies')).not.toBeInTheDocument()
    expect(screen.queryByText('No pools over 80% budget usage.')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2)
  })

  it('keeps pending anomaly data distinct from a successful empty result', async () => {
    let resolveAnomalies!: (value: unknown) => void
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/expenses/anomalies')) return await new Promise<unknown>((resolve) => { resolveAnomalies = resolve }) as never
      return { data: response(url) }
    })
    renderDashboard()
    await screen.findByText('$600.00')
    expect(screen.queryByText('No Anomalies')).not.toBeInTheDocument()
    await act(async () => resolveAnomalies({ data: { anomalies: [] } }))
    expect(await screen.findByText('No Anomalies')).toBeInTheDocument()
  })

  it('renders independent panels while a summary request is still pending', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/expenses/summary')) return await new Promise<never>(() => {})
      return { data: response(url) }
    })
    renderDashboard()
    await screen.findByText('$600.00')
    expect(within(metric('Active Recommendations')).getByText('7')).toBeInTheDocument()
    expect(within(metric('Total Cost')).getByRole('status')).toBeInTheDocument()
    expect(within(metric('Total Cost')).queryByText('Unavailable')).not.toBeInTheDocument()
  })

  it('rejects malformed successful responses rather than inventing zeros', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/recommendations/summary') ? { data: {} } : response(url) }))
    renderDashboard()
    await screen.findByText('Some overview metrics are unavailable. Available data is shown below.')
    expect(within(metric('Active Recommendations')).getByText('Unavailable')).toBeInTheDocument()
  })

  it('only offers onboarding after successful empty billing and account checks, scoped to the workspace', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/org-a/expenses/summary')) return { data: { data: { total_cost: 0, resource_count: 0 } } }
      if (url.includes('/org-a/cloud-accounts')) return { data: { data: [] } }
      return { data: response(url) }
    })
    renderDashboard()
    expect(await screen.findByText('Welcome to CloudAtlas!')).toBeInTheDocument()
    act(() => useOrgStore.getState().setCurrentOrg({ id: 'org-b', name: 'Other', slug: 'other' }))
    await screen.findByText('$600.00')
    expect(screen.queryByText('Welcome to CloudAtlas!')).not.toBeInTheDocument()
  })

  it('aborts every pending dashboard source on workspace change', async () => {
    const signals: AbortSignal[] = []
    vi.mocked(api.get).mockImplementation(async (_url, config) => {
      signals.push(config!.signal as AbortSignal)
      return await new Promise<never>(() => {})
    })
    renderDashboard()
    await waitFor(() => expect(signals).toHaveLength(9))
    const previous = [...signals]
    act(() => useOrgStore.getState().setCurrentOrg({ id: 'org-b', name: 'Other', slug: 'other' }))
    await waitFor(() => expect(previous.every((signal) => signal.aborted)).toBe(true))
  })

  it('handles a missing workspace without requests or zero metrics', () => {
    useOrgStore.getState().clearOrg()
    renderDashboard()
    expect(screen.getByText('Select a workspace to view its overview.')).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })
})

describe('Dashboard date periods', () => {
  it('requests MTD independently of the inclusive 30 day chart across year boundaries', () => {
    expect(dashboardPeriods(new Date('2026-01-01T09:00:00Z'))).toEqual({
      end: '2026-01-01',
      month: 'start_date=2026-01-01&end_date=2026-01-01',
      recent: 'start_date=2025-12-03&end_date=2026-01-01',
    })
  })
})
