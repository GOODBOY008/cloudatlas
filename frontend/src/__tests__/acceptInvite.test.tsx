import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import axios from 'axios'
import AcceptInvite from '../pages/AcceptInvite'
import Login from '../pages/Login'
import SsoSession from '../pages/SsoSession'
import api from '../lib/api'
import { auth } from '../lib/auth'
import { LOGIN_RETURN_PATH_KEY, SSO_COMPLETE_PATH, loginRedirect } from '../lib/loginRedirect'
import { useOrgStore } from '../store/orgStore'

vi.mock('../lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
const me = { id: 'user-a', email: 'alice@example.com', display_name: 'Alice' }
const existing = { id: 'org-a', name: 'Old workspace', slug: 'old' }
const invited = { id: 'org-b', name: 'Invited workspace', slug: 'invited' }

function LocationView() {
  const location = useLocation()
  return <p data-testid="location">{location.pathname}{location.search}</p>
}

function renderInvite(url = '/accept-invite?token=invitation-secret') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[url]}><Routes>
    <Route path="/accept-invite" element={<AcceptInvite />} />
    <Route path="/dashboard" element={<LocationView />} />
  </Routes></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.clearTokens()
  sessionStorage.removeItem(LOGIN_RETURN_PATH_KEY)
  useOrgStore.getState().setOrganizations([existing])
  vi.mocked(api.get).mockImplementation(async path => {
    if (path === '/auth/me') return { data: { data: me } }
    if (path === '/organizations') return { data: { data: [existing, invited] } }
    return { data: { data: { enabled: false } } }
  })
  vi.mocked(api.post).mockResolvedValue({ data: { data: { organization_id: invited.id } } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('workspace invitation confirmation', () => {
  it('requires a token and never submits an incomplete invitation', () => {
    renderInvite('/accept-invite')
    expect(screen.getByRole('alert')).toHaveTextContent('invitation link is incomplete')
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('shows the signed-in account and waits for explicit confirmation before selecting the joined workspace', async () => {
    renderInvite()
    expect(await screen.findByText('Signed in as alice@example.com')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'))
    expect(api.post).toHaveBeenCalledWith('/auth/accept-invite', { token: 'invitation-secret' })
    expect(useOrgStore.getState().currentOrg).toEqual(invited)
    expect(useOrgStore.getState().organizations).toEqual([existing, invited])
  })

  it('offers retry for a failed acceptance without switching workspaces', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Expired'))
    renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be accepted')
    expect(useOrgStore.getState().currentOrg).toEqual(existing)
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await screen.findByTestId('location')
    expect(api.post).toHaveBeenCalledTimes(2)
  })

  it('retries only workspace loading after acceptance succeeds', async () => {
    let orgReads = 0
    vi.mocked(api.get).mockImplementation(async path => {
      if (path === '/auth/me') return { data: { data: me } }
      if (orgReads++ === 0) throw new Error('Temporary network failure')
      return { data: { data: [existing, invited] } }
    })
    renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('invitation was accepted')
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    await screen.findByTestId('location')
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(useOrgStore.getState().currentOrg).toEqual(invited)
  })

  it('requires account identity to load before accepting, and allows identity retry', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Network unavailable'))
    renderInvite()
    expect(await screen.findByRole('alert')).toHaveTextContent('account details could not be loaded')
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Signed in as alice@example.com')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('does not change the selected workspace when the user leaves during acceptance', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(api.post).mockReturnValueOnce(new Promise(res => { resolve = res }))
    const view = renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    view.unmount()
    await act(async () => resolve({ data: { data: { organization_id: invited.id } } }))
    expect(useOrgStore.getState().currentOrg).toEqual(existing)
    expect(api.get).not.toHaveBeenCalledWith('/organizations')
  })
})

describe('login return navigation', () => {
  it('restores the tab-local invitation destination after an SSO round trip', async () => {
    sessionStorage.setItem(LOGIN_RETURN_PATH_KEY, '/accept-invite?token=sso-invite')
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { data: { session_id: 'session-a', access_token: 'sso-access-in-memory' } },
    })
    render(<StrictMode><MemoryRouter initialEntries={[SSO_COMPLETE_PATH]}>
      <Routes><Route path={SSO_COMPLETE_PATH} element={<SsoSession />} /><Route path="*" element={<LocationView />} /></Routes>
    </MemoryRouter></StrictMode>)
    expect(await screen.findByTestId('location')).toHaveTextContent('/accept-invite?token=sso-invite')
    expect(sessionStorage.getItem(LOGIN_RETURN_PATH_KEY)).toBeNull()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/v1/auth/oidc/session', { session_id: null }, expect.anything())
    expect(auth.getAccessToken()).toBe('sso-access-in-memory')
    expect(localStorage.getItem('ca_access_token')).toBeNull()
    expect(localStorage.getItem('ca_refresh_token')).toBeNull()
    expect(localStorage.getItem('cloudatlas-auth')).not.toContain('sso-access-in-memory')
  })

  it('does not accept supplied bearer credentials from a login URL', async () => {
    render(<MemoryRouter initialEntries={['/login?token=untrusted-access&refresh=untrusted-refresh']}>
      <Routes><Route path="/login" element={<Login />} /><Route path="*" element={<LocationView />} /></Routes>
    </MemoryRouter>)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/auth/oidc/config'))
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
    expect(auth.getAccessToken()).toBeNull()
    expect(auth.getRefreshToken()).toBeNull()
  })

  it('returns to the invitation deep link after a successful login', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: { data: { access_token: 'access-a', refresh_token: 'refresh-a' } } })
    render(<MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/accept-invite?token=invite-token' } }]}>
      <Routes><Route path="/login" element={<Login />} /><Route path="*" element={<LocationView />} /></Routes>
    </MemoryRouter>)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: me.email } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password123!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    expect(await screen.findByTestId('location')).toHaveTextContent('/accept-invite?token=invite-token')
  })

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/\nevil.example', '/login?token=x', '/reset-password', SSO_COMPLETE_PATH, null, { pathname: '/private' }])('rejects an unsafe or looping return destination: %s', from => {
    expect(loginRedirect(from)).toBe('/dashboard')
  })

  it('preserves a valid local path, query and fragment', () => {
    expect(loginRedirect('/expenses?service=compute#trend')).toBe('/expenses?service=compute#trend')
  })
})
