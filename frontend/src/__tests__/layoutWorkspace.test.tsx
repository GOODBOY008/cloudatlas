import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import Layout from '../components/Layout'
import api from '../lib/api'
import { getOrgCurrency, setOrgCurrency } from '../lib/format'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'

vi.mock('../lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../components/CopilotPanel', () => ({ default: () => null }))
vi.mock('../components/copilot/CopilotFab', () => ({ default: () => null }))
vi.mock('../components/NotificationBell', () => ({ default: () => null }))
vi.mock('../components/BackgroundJobsIndicator', () => ({ default: () => null }))
vi.mock('../components/GlobalSearch', () => ({ default: () => null }))

const organizations: Organization[] = [
  { id: 'org-001', name: 'Acme Corp', slug: 'acme' },
  { id: 'org-002', name: 'Beta Inc', slug: 'beta' },
]
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<h1>Workspace content</h1>} />
        </Route>
        <Route path="/login" element={<Link to="/dashboard">Sign back in</Link>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useOrgStore.getState().clearOrg()
  setOrgCurrency('USD')
  vi.mocked(api.get).mockReset()
  vi.mocked(api.get).mockImplementation((url) => Promise.resolve({
    data: { data: url === '/organizations' ? organizations : { settings: { currency: url.endsWith('org-002') ? 'EUR' : 'USD' } } },
  }))
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })))
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

describe('workspace selection in Layout', () => {
  it('preserves the selected workspace and its currency across a layout remount', async () => {
    useOrgStore.getState().setCurrentOrg({ ...organizations[1], name: 'Old Beta name' })
    renderLayout()
    await waitFor(() => expect(getOrgCurrency()).toBe('EUR'))
    expect(screen.getByRole('button', { name: 'Switch workspace' })).toHaveTextContent('Beta Inc')

    await userEvent.click(screen.getByRole('button', { name: 'Logout' }))
    await userEvent.click(screen.getByRole('link', { name: 'Sign back in' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4))
    expect(screen.getByRole('button', { name: 'Switch workspace' })).toHaveTextContent('Beta Inc')
    expect(getOrgCurrency()).toBe('EUR')
    expect(api.get).not.toHaveBeenCalledWith('/organizations/org-001')
  })

  it('keeps persisted state valid when switching workspaces and rehydrating', async () => {
    const view = renderLayout()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Switch workspace' })).toHaveTextContent('Acme Corp'))
    await userEvent.click(screen.getByRole('button', { name: 'Switch workspace' }))
    await userEvent.click(screen.getByRole('button', { name: 'Beta Inc' }))
    await waitFor(() => expect(getOrgCurrency()).toBe('EUR'))

    const saved = JSON.parse(localStorage.getItem('cloudatlas-org')!)
    expect(saved.state.currentOrg.id).toBe('org-002')
    expect(saved.state.organizations).toEqual(organizations)
    view.unmount()
    await useOrgStore.persist.rehydrate()
    renderLayout()
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(5))
    expect(screen.getByRole('button', { name: 'Switch workspace' })).toHaveTextContent('Beta Inc')
  })

  it('falls back to an available workspace when the previous one is removed', async () => {
    useOrgStore.getState().setCurrentOrg({ id: 'removed', name: 'Removed', slug: 'removed' })
    renderLayout()
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/organizations/org-001'))
    expect(screen.getByRole('button', { name: 'Switch workspace' })).toHaveTextContent('Acme Corp')
  })
})
