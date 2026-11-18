import axios, { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from '../lib/api'
import { auth } from '../lib/auth'
import { queryClient } from '../lib/queryClient'
import { getOrgCurrency, setOrgCurrency } from '../lib/format'
import { useAuthStore } from '../store/authStore'
import { useOrgStore } from '../store/orgStore'
import { useCopilotStore } from '../store/copilotStore'

const org = { id: 'org-a', name: 'Workspace A', slug: 'a', created_at: 0 }
const originalAdapter = api.defaults.adapter

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function response(config: InternalAxiosRequestConfig, data: unknown = {}) {
  return { config, data, status: 200, statusText: 'OK', headers: new AxiosHeaders() }
}

function unauthorized(config: InternalAxiosRequestConfig) {
  return new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined,
    { ...response(config), status: 401, statusText: 'Unauthorized' })
}

const refreshed = {
  data: { data: { access_token: 'access-refreshed', refresh_token: 'refresh-refreshed' } },
} as AxiosResponse

beforeEach(() => {
  auth.clearTokens()
  auth.setTokens('access-a', 'refresh-a')
  vi.spyOn(auth, 'logout').mockImplementation(() => auth.clearTokens())
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  auth.clearTokens()
  vi.restoreAllMocks()
})

describe('session data isolation', () => {
  it('clears cached data, workspace, auth state and open copilot on logout, preserving appearance', () => {
    useOrgStore.getState().setOrganizations([org])
    useCopilotStore.getState().setWidth(480)
    useCopilotStore.getState().setOpen(true)
    setOrgCurrency('CNY')
    queryClient.setQueryData(['expenses', org.id], { total_cost: 999 })
    localStorage.setItem('cloudatlas-theme', 'saved-theme')

    auth.clearTokens()

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(useOrgStore.getState().currentOrg).toBeNull()
    expect(useOrgStore.getState().organizations).toEqual([])
    expect(useAuthStore.getState().isAuthenticated()).toBe(false)
    expect(useCopilotStore.getState().open).toBe(false)
    expect(useCopilotStore.getState().width).toBe(480)
    expect(getOrgCurrency()).toBe('USD')
    expect(localStorage.getItem('ca_access_token')).toBeNull()
    expect(JSON.parse(localStorage.getItem('cloudatlas-org')!).state.currentOrg).toBeNull()
    expect(localStorage.getItem('cloudatlas-theme')).toBe('saved-theme')
    localStorage.removeItem('cloudatlas-theme')
  })

  it('starts a clean login but keeps the current workspace and cache during token rotation', () => {
    useOrgStore.getState().setOrganizations([org])
    queryClient.setQueryData(['expenses', org.id], { total_cost: 999 })
    const version = auth.getSessionVersion()
    expect(auth.refreshTokens('access-new', 'refresh-new', version, 'refresh-a')).toBe(true)
    expect(useOrgStore.getState().currentOrg?.id).toBe(org.id)
    expect(queryClient.getQueryData(['expenses', org.id])).toEqual({ total_cost: 999 })
    expect(useAuthStore.getState().accessToken).toBe('access-new')

    auth.setTokens('access-b', 'refresh-b')
    expect(useOrgStore.getState().currentOrg).toBeNull()
    expect(queryClient.getQueryData(['expenses', org.id])).toBeUndefined()
    expect(auth.refreshTokens('late-token', 'late-refresh', version, 'refresh-new')).toBe(false)
    expect(auth.getAccessToken()).toBe('access-b')
  })

  it('cancels active cached queries and discards their late results at logout', async () => {
    const pending = deferred<{ total_cost: number }>()
    const query = queryClient.fetchQuery({ queryKey: ['expenses', org.id], queryFn: () => pending.promise })
    const settled = Promise.allSettled([query])
    auth.clearTokens()
    pending.resolve({ total_cost: 999 })
    expect((await settled)[0].status).toBe('rejected')
    expect(queryClient.getQueryData(['expenses', org.id])).toBeUndefined()
  })
})

describe('API refresh coordination', () => {
  it('restores a signed-in SSO session with one cookie request and preserves its cache', async () => {
    const post = vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { session_id: 'sso-a', access_token: 'sso-first' } } })
      .mockResolvedValueOnce({ data: { data: { session_id: 'sso-a', access_token: 'sso-renewed' } } })
    expect(await auth.completeSsoSignIn()).toBe(true)
    useOrgStore.getState().setOrganizations([org])
    queryClient.setQueryData(['expenses', org.id], { total_cost: 999 })
    api.defaults.adapter = async config => {
      if (config.headers.Authorization === 'Bearer sso-first') throw unauthorized(config)
      expect(config.headers.Authorization).toBe('Bearer sso-renewed')
      return response(config)
    }
    await Promise.all([api.get('/one'), api.get('/two')])
    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenLastCalledWith('/api/v1/auth/oidc/session', { session_id: 'sso-a' }, expect.anything())
    expect(useOrgStore.getState().currentOrg?.id).toBe(org.id)
    expect(queryClient.getQueryData(['expenses', org.id])).toEqual({ total_cost: 999 })
    expect(localStorage.getItem('ca_access_token')).toBeNull()
  })

  it('never retries a request with the credentials of a replacement SSO session', async () => {
    vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { session_id: 'sso-a', access_token: 'sso-first' } } })
      .mockResolvedValueOnce({ data: { data: { session_id: 'sso-b', access_token: 'other-user' } } })
    await auth.completeSsoSignIn()
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => { throw unauthorized(config) })
    api.defaults.adapter = adapter
    await expect(api.get('/private')).rejects.toMatchObject({ code: 'ERR_CANCELED' })
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(auth.getAccessToken()).toBeNull()
  })

  it('signs out an SSO session after server revocation and supports retry', async () => {
    vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { session_id: 'sso-a', access_token: 'sso-first' } } })
    await auth.completeSsoSignIn()
    const revoke = vi.spyOn(axios, 'delete')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ status: 204 })
    await expect(auth.signOut()).rejects.toThrow('Offline')
    expect(auth.getAccessToken()).toBe('sso-first')
    await expect(auth.signOut()).resolves.toBe(true)
    expect(revoke).toHaveBeenLastCalledWith('/api/v1/auth/oidc/session', expect.objectContaining({
      data: { session_id: 'sso-a' },
    }))
    expect(auth.getAccessToken()).toBeNull()
    expect(localStorage.getItem('ca_sso_session')).toBeNull()
  })

  it('clears an older tab on a replacement login without deleting the new session marker', async () => {
    vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { session_id: 'sso-a', access_token: 'sso-first' } } })
    await auth.completeSsoSignIn()
    localStorage.setItem('ca_sso_session', 'sso-b')
    window.dispatchEvent(new StorageEvent('storage', { key: 'ca_sso_session', newValue: 'sso-b' }))
    expect(auth.getAccessToken()).toBeNull()
    expect(localStorage.getItem('ca_sso_session')).toBe('sso-b')
    localStorage.removeItem('ca_sso_session')
  })

  it('retains the refresh token when the backend only returns a new access token', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { data: { access_token: 'access-refreshed' } } })
    api.defaults.adapter = async config => {
      if (config.headers.Authorization === 'Bearer access-a') throw unauthorized(config)
      return response(config)
    }
    await api.get('/private')
    expect(auth.getAccessToken()).toBe('access-refreshed')
    expect(auth.getRefreshToken()).toBe('refresh-a')
  })

  it('shares one refresh across concurrent requests and retries each with the rotated token', async () => {
    const refresh = deferred<AxiosResponse>()
    const post = vi.spyOn(axios, 'post').mockReturnValue(refresh.promise)
    const headers: unknown[] = []
    api.defaults.adapter = async config => {
      headers.push(config.headers.Authorization)
      if (config.headers.Authorization === 'Bearer access-a') throw unauthorized(config)
      return response(config, { ok: true })
    }
    const first = api.get('/orgs/org-a/resources')
    const second = api.get('/orgs/org-a/expenses')
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    refresh.resolve(refreshed)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(headers.filter(value => value === 'Bearer access-refreshed')).toHaveLength(2)
    expect(auth.logout).not.toHaveBeenCalled()
  })

  it('rejects every waiting request when refresh fails instead of leaving them pending', async () => {
    const refresh = deferred<AxiosResponse>()
    const post = vi.spyOn(axios, 'post').mockReturnValue(refresh.promise)
    api.defaults.adapter = async config => { throw unauthorized(config) }
    const requests = Promise.allSettled([api.get('/first'), api.get('/second')])
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    refresh.reject(new Error('Refresh unavailable'))
    expect((await requests).map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(auth.logout).toHaveBeenCalledTimes(1)
  })

  it('does not revive a logged-out session or replay its request after a late refresh succeeds', async () => {
    const refresh = deferred<AxiosResponse>()
    const post = vi.spyOn(axios, 'post').mockReturnValue(refresh.promise)
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => { throw unauthorized(config) })
    api.defaults.adapter = adapter
    const result = Promise.allSettled([api.get('/private')])
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    auth.clearTokens()
    refresh.resolve(refreshed)
    expect((await result)[0].status).toBe('rejected')
    expect(auth.getAccessToken()).toBeNull()
    expect(adapter).toHaveBeenCalledTimes(1)
  })

  it('does not sign out a new login when an earlier refresh fails', async () => {
    const refresh = deferred<AxiosResponse>()
    const post = vi.spyOn(axios, 'post').mockReturnValue(refresh.promise)
    api.defaults.adapter = async config => { throw unauthorized(config) }
    const result = Promise.allSettled([api.get('/private')])
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    auth.setTokens('access-b', 'refresh-b')
    refresh.reject(new Error('Old refresh failed'))
    expect((await result)[0].status).toBe('rejected')
    expect(auth.getAccessToken()).toBe('access-b')
    expect(auth.logout).not.toHaveBeenCalled()
  })

  it('rejects late responses from the previous user before consumers can display them', async () => {
    const request = deferred<AxiosResponse>()
    let config: InternalAxiosRequestConfig | undefined
    api.defaults.adapter = value => { config = value; return request.promise }
    const result = Promise.allSettled([api.get('/private')])
    await vi.waitFor(() => expect(config).toBeDefined())
    auth.setTokens('access-b', 'refresh-b')
    request.resolve(response(config!, { secret: 'user-a-data' }))
    const settled = await result
    expect(settled[0].status).toBe('rejected')
    if (settled[0].status === 'rejected') expect(axios.isCancel(settled[0].reason)).toBe(true)
  })

  it('does not replay a previous user\'s late 401 with the new user\'s credentials', async () => {
    const request = deferred<AxiosResponse>()
    const post = vi.spyOn(axios, 'post')
    let config: InternalAxiosRequestConfig | undefined
    const adapter = vi.fn((value: InternalAxiosRequestConfig) => { config = value; return request.promise })
    api.defaults.adapter = adapter
    const result = Promise.allSettled([api.get('/private')])
    await vi.waitFor(() => expect(config).toBeDefined())
    auth.setTokens('access-b', 'refresh-b')
    request.reject(unauthorized(config!))
    expect((await result)[0].status).toBe('rejected')
    expect(post).not.toHaveBeenCalled()
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(auth.getAccessToken()).toBe('access-b')
  })

  it('uses the already rotated token for a slow 401 instead of refreshing a second time', async () => {
    const slowRequest = deferred<AxiosResponse>()
    const post = vi.spyOn(axios, 'post').mockResolvedValue(refreshed)
    let slowConfig: InternalAxiosRequestConfig | undefined
    api.defaults.adapter = async config => {
      if (config.headers.Authorization === 'Bearer access-refreshed') return response(config)
      if (config.url === '/slow') { slowConfig = config; return slowRequest.promise }
      throw unauthorized(config)
    }
    const slow = api.get('/slow')
    await api.get('/fast')
    slowRequest.reject(unauthorized(slowConfig!))
    await expect(slow).resolves.toHaveProperty('status', 200)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps invalid login errors local and does not refresh or redirect', async () => {
    const post = vi.spyOn(axios, 'post')
    api.defaults.adapter = async config => { throw unauthorized(config) }
    await expect(api.post('/auth/login', { email: 'a@example.com', password: 'wrong' })).rejects.toBeInstanceOf(AxiosError)
    expect(post).not.toHaveBeenCalled()
    expect(auth.logout).not.toHaveBeenCalled()
  })

  it('retries at most once when the refreshed token is also rejected', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue(refreshed)
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => { throw unauthorized(config) })
    api.defaults.adapter = adapter
    await expect(api.get('/private')).rejects.toBeInstanceOf(AxiosError)
    expect(post).toHaveBeenCalledTimes(1)
    expect(adapter).toHaveBeenCalledTimes(2)
    expect(auth.logout).toHaveBeenCalledTimes(1)
  })
})
