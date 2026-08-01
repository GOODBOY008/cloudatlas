import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useOrgStore } from '../store/orgStore'
import en from '../i18n/locales/en'
import zh from '../i18n/locales/zh'
import type { AccountJob, Organization } from '../types'

// Mock the API layer — named job helpers + the default axios-like instance.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  listJobs: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  default: { get: mocks.get, post: mocks.post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  listJobs: mocks.listJobs,
  getJob: mocks.getJob,
  cancelJob: mocks.cancelJob,
}))

import { useActiveJobs, useJob } from '../lib/hooks/useJobs'
import BillingImport from '../pages/BillingImport'

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

function runningJob(overrides: Partial<AccountJob> = {}): AccountJob {
  return {
    id: 'job-1',
    organization_id: org.id,
    cloud_account_id: 'acct-1',
    account_name: 'Aliyun Prod',
    job_kind: 'billing_import',
    status: 'running',
    phase: 'fetching',
    progress_current: 12,
    progress_total: 30,
    params: { days: 30 },
    result: {},
    resources_discovered: null,
    resources_created: null,
    resources_updated: null,
    resources_deleted: null,
    error_message: null,
    triggered_by: 'user-1',
    created_at: '2026-09-09T03:00:00Z',
    started_at: '2026-09-09T03:00:01Z',
    completed_at: null,
    updated_at: '2026-09-09T03:00:14Z',
    ...overrides,
  }
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return Wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  useOrgStore.setState({ currentOrg: org, organizations: [org] })
  mocks.listJobs.mockResolvedValue([])
  mocks.getJob.mockResolvedValue(runningJob())
  mocks.cancelJob.mockResolvedValue(runningJob({ status: 'cancelled' }))
})

// ─── useJobs hooks (spec §7: polling behavior) ──────────────────────────────

describe('useJob polling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls while running and stops once terminal', async () => {
    // Default (post-sequence) resolves terminal so polling provably stops.
    const done = runningJob({
      status: 'succeeded',
      phase: null,
      progress_current: null,
      progress_total: null,
      completed_at: '2026-09-09T03:01:00Z',
      result: { provider: 'alibaba', raw_rows_inserted: 210, days_imported: 30 },
    })
    mocks.getJob.mockResolvedValue(done)
    // running → running → succeeded
    mocks.getJob
      .mockResolvedValueOnce(runningJob())
      .mockResolvedValueOnce(runningJob({ phase: 'importing', progress_current: 500 }))
      .mockResolvedValueOnce(done)

    const { result } = renderHook(() => useJob(org.id, 'job-1'), { wrapper: wrapper() })

    // Drive the fake clock until the terminal state lands (the interval is
    // only armed after the first fetch resolves, so poll in small steps).
    for (let i = 0; i < 30 && result.current.data?.status !== 'succeeded'; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    }
    expect(result.current.data?.status).toBe('succeeded')

    const callsAtTerminal = mocks.getJob.mock.calls.length
    expect(callsAtTerminal).toBeGreaterThanOrEqual(3)

    // No further polling after the terminal state.
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(mocks.getJob.mock.calls.length).toBe(callsAtTerminal)
  })
})

describe('useActiveJobs polling interval switch', () => {
  it('polls the active list with active=true', async () => {
    mocks.listJobs.mockResolvedValue([runningJob()])
    const { result } = renderHook(() => useActiveJobs(org.id), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(mocks.listJobs).toHaveBeenCalledWith(org.id, { active: true })
  })
})

// ─── BillingImport progress card (spec §7: determinate/indeterminate/cancel) ──

describe('BillingImport progress card', () => {
  function renderPage() {
    mocks.get.mockImplementation((url: string) => {
      if (url.includes('/cloud-accounts')) {
        return Promise.resolve({
          data: {
            data: [
              { id: 'acct-1', name: 'Aliyun Prod', provider: 'alibaba', is_active: true, currency: 'CNY', resource_count: 3, last_sync_at: null, has_credentials: true },
            ],
          },
        })
      }
      return Promise.resolve({ data: { data: [] } })
    })
    mocks.post.mockImplementation((url: string) => {
      if (url.includes('/billing/import')) {
        return Promise.resolve({ data: { data: runningJob() } })
      }
      return Promise.resolve({ data: { data: {} } })
    })
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BillingImport />
      </QueryClientProvider>,
    )
  }

  async function submitImport() {
    // Wait for the account list to load (submit is disabled while loading).
    await screen.findByText(/Aliyun Prod/)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acct-1' } })
    fireEvent.click(screen.getByRole('button', { name: /run import/i }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(expect.stringContaining('/billing/import'), expect.anything()))
  }

  it('shows the determinate progress card with phase label after the 202 response', async () => {
    renderPage()
    await submitImport()

    const card = await screen.findByTestId('billing-progress-card')
    expect(card).toBeInTheDocument()
    // Phase label localized (mock job phase = fetching).
    expect(card.textContent).toContain('Fetching billing data')
    // Determinate numbers rendered.
    expect(card.textContent).toContain('12 / 30')
    // Cancel control present.
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('renders an indeterminate bar when progress_total is null', async () => {
    mocks.getJob.mockResolvedValue(runningJob({ phase: 'aggregating', progress_current: null, progress_total: null }))
    renderPage()
    await submitImport()

    const card = await screen.findByTestId('billing-progress-card')
    expect(card.querySelector('.animate-pulse')).not.toBeNull()
    expect(card.textContent).not.toContain('/')
  })

  it('shows the result box with the terminal numbers', async () => {
    mocks.getJob.mockResolvedValue(
      runningJob({
        status: 'succeeded',
        phase: null,
        progress_current: null,
        progress_total: null,
        completed_at: '2026-09-09T03:01:00Z',
        result: { provider: 'alibaba', raw_rows_inserted: 45230, days_imported: 30 },
      }),
    )
    renderPage()
    await submitImport()

    const box = await screen.findByTestId('billing-result-box')
    expect(box.textContent).toContain('Import completed')
    expect(box.textContent).toContain('45230')
    expect(box.textContent).toContain('30 days')
  })

  it('shows the error message for a failed job', async () => {
    mocks.getJob.mockResolvedValue(
      runningJob({
        status: 'failed',
        error_message: 'BSS API timeout',
        completed_at: '2026-09-09T03:01:00Z',
      }),
    )
    renderPage()
    await submitImport()

    const box = await screen.findByTestId('billing-result-box')
    expect(box.textContent).toContain('BSS API timeout')
  })

  it('cancel asks for confirmation then calls cancelJob', async () => {
    renderPage()
    await submitImport()

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    // Confirm step (spec: cancel via existing confirm pattern).
    fireEvent.click(screen.getByRole('button', { name: /confirm cancel/i }))
    await waitFor(() => expect(mocks.cancelJob).toHaveBeenCalledWith(org.id, 'job-1'))
  })

  it('surfaces the 409 conflict body when a job is already active', async () => {
    renderPage()
    mocks.post.mockImplementation((url: string) => {
      if (url.includes('/billing/import')) {
        return Promise.reject({
          response: { status: 409, data: { error: { message: 'A billing import is already running', details: { existing_job_id: 'job-9' } } } },
        })
      }
      return Promise.resolve({ data: { data: {} } })
    })
    await submitImport()

    await waitFor(() =>
      expect(screen.getByText(/already running for this account/i)).toBeInTheDocument(),
    )
  })

  it('renders the recent import jobs list', async () => {
    mocks.listJobs.mockResolvedValue([
      runningJob({
        id: 'job-old',
        status: 'succeeded',
        triggered_by: 'scheduler',
        completed_at: '2026-09-09T02:00:00Z',
        result: { provider: 'alibaba', raw_rows_inserted: 100, days_imported: 3 },
        params: { days: 3 },
      }),
    ])
    renderPage()

    expect(await screen.findByText('Recent Import Jobs')).toBeInTheDocument()
    expect(await screen.findByText('Scheduler')).toBeInTheDocument()
    expect(mocks.listJobs).toHaveBeenCalledWith(org.id, { kind: 'billing_import', limit: 10 })
  })
})

// ─── i18n key presence (spec §5.6 — both locales, no defaultValue-only) ──────

describe('async jobs i18n keys', () => {
  const SPEC_KEYS = [
    'jobs.kind.discovery',
    'jobs.kind.billingImport',
    'jobs.status.pending',
    'jobs.status.running',
    'jobs.status.succeeded',
    'jobs.status.failed',
    'jobs.status.cancelled',
    'jobs.phase.discovering',
    'jobs.phase.upserting',
    'jobs.phase.k8sClusters',
    'jobs.phase.finalizing',
    'jobs.phase.fetching',
    'jobs.phase.importing',
    'jobs.phase.aggregating',
    'jobs.cancel',
    'jobs.cancelConfirm',
    'jobs.cancelled',
    'jobs.conflictTitle',
    'jobs.conflictBody',
    'jobs.activeJobs',
    'jobs.recentJobs',
    'jobs.triggeredBy.user',
    'jobs.triggeredBy.scheduler',
    'billingImport.progressTitle',
    'billingImport.recentImports',
    'cloudAccounts.syncInProgress',
    'cloudAccounts.importInProgress',
    'notifications.kind.sync',
  ]

  it.each(SPEC_KEYS)('%s exists with non-empty copy in en and zh', (key) => {
    const enVal = (en as Record<string, string>)[key]
    const zhVal = (zh as Record<string, string>)[key]
    expect(enVal, `en:${key}`).toBeTruthy()
    expect(zhVal, `zh:${key}`).toBeTruthy()
    expect(enVal.trim().length).toBeGreaterThan(0)
    expect(zhVal.trim().length).toBeGreaterThan(0)
    expect(zhVal).not.toBe(enVal) // zh authored in parallel, not copied EN copy
  })
})
