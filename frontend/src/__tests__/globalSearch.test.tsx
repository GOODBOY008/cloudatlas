import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GlobalSearch from '../components/GlobalSearch'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { EMPTY_RESULTS } from '../features/search/useWorkspaceSearch'

vi.mock('../lib/api', () => ({ default: { get: vi.fn() } }))

function Harness() {
  const [open, setOpen] = useState(true)
  const location = useLocation()
  return <><p data-testid="location">{location.pathname}</p><GlobalSearch open={open} onOpenChange={setOpen} /></>
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><Harness /></MemoryRouter></QueryClientProvider>)
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  useOrgStore.getState().clearOrg()
  vi.mocked(api.get).mockReset().mockResolvedValue({ data: { data: EMPTY_RESULTS } })
})

describe('global feature and workspace search', () => {
  it('provides keyboard feature navigation without a workspace or network request', async () => {
    setup()
    const input = screen.getByRole('combobox', { name: 'Search' })
    await userEvent.type(input, 'CMDB Audit')
    expect(screen.getByRole('option')).toHaveTextContent('CMDB Audit Log')
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('location')).toHaveTextContent('/cmdb-audit')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('finds Chinese page names while using English UI', async () => {
    setup()
    await userEvent.type(screen.getByRole('combobox'), '审计')
    expect(screen.getByRole('option')).toHaveTextContent('CMDB Audit Log')
  })

  it('lets the Chinese IME own arrows and composition-confirming Enter', async () => {
    setup()
    const input = screen.getByRole('combobox')
    const initial = input.getAttribute('aria-activedescendant')
    expect(fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })).toBe(true)
    expect(input).toHaveAttribute('aria-activedescendant', initial)

    fireEvent.compositionStart(input)
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true)
    fireEvent.change(input, { target: { value: '审计' } })
    expect(screen.getByRole('option')).toHaveTextContent('CMDB Audit Log')
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true)
    fireEvent.compositionEnd(input, { data: '审计' })
    // Safari can deliver compositionend before this confirming Enter.
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false })).toBe(true)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)

    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('location')).toHaveTextContent('/cmdb-audit')
  })

  it('allows arrows to choose quick navigation and Escape to close', async () => {
    setup()
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps feature navigation available on API failure and supports retry', async () => {
    useOrgStore.getState().setCurrentOrg({ id: 'a', name: 'A', slug: 'a' })
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'))
    setup()
    await userEvent.type(screen.getByRole('combobox'), 'audit')
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace search is unavailable')
    expect(screen.getByRole('option')).toHaveTextContent('CMDB Audit Log')
    await userEvent.click(screen.getByRole('button', { name: 'Retry search' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('never displays a late search result from the previous workspace', async () => {
    const first = deferred()
    useOrgStore.getState().setCurrentOrg({ id: 'a', name: 'A', slug: 'a' })
    vi.mocked(api.get).mockImplementation((url) => url.includes('/a/') ? first.promise as ReturnType<typeof api.get> : Promise.resolve({ data: { data: { ...EMPTY_RESULTS, pools: [{ id: 'b', name: 'Beta result' }] } } }))
    setup()
    await userEvent.type(screen.getByRole('combobox'), 'unique')
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    act(() => useOrgStore.getState().setCurrentOrg({ id: 'b', name: 'B', slug: 'b' }))
    expect(await screen.findByRole('option', { name: 'Beta result' })).toBeInTheDocument()
    await act(async () => first.resolve({ data: { data: { ...EMPTY_RESULTS, pools: [{ id: 'a', name: 'Alpha stale' }] } } }))
    expect(screen.queryByText('Alpha stale')).not.toBeInTheDocument()
    expect(screen.getByText('Beta result')).toBeInTheDocument()
  })

  it('clears pending state when the search term becomes too short', async () => {
    useOrgStore.getState().setCurrentOrg({ id: 'a', name: 'A', slug: 'a' })
    const pending = deferred()
    vi.mocked(api.get).mockReturnValue(pending.promise as ReturnType<typeof api.get>)
    setup()
    await userEvent.type(screen.getByRole('combobox'), 'unique')
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    await userEvent.clear(screen.getByRole('combobox'))
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    expect(screen.getByText('Quick navigation')).toBeInTheDocument()
  })
})
