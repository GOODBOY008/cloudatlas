import axios, { AxiosError, CanceledError, type InternalAxiosRequestConfig } from 'axios'
import { auth } from './auth'
import type { ApiResponse } from '../types'

const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

interface SessionRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean
  _sessionVersion?: number
}

const publicAuthPaths = new Set([
  '/auth/login', '/auth/register', '/auth/refresh', '/auth/forgot-password',
  '/auth/reset-password', '/auth/verify-email', '/auth/oidc/config',
])

function sessionChanged(config: SessionRequestConfig) {
  return config._sessionVersion !== auth.getSessionVersion()
}

// A request keeps its original session even when retried. Never send an old
// user's queued request with a new user's credentials.
api.interceptors.request.use((config: SessionRequestConfig) => {
  config._sessionVersion ??= auth.getSessionVersion()
  if (sessionChanged(config)) throw new CanceledError('Session changed')
  const token = auth.getAccessToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  else delete config.headers.Authorization
  return config
})

let pendingRefresh: { version: number; promise: Promise<void> } | undefined

interface RefreshResponse {
  access_token: string
  refresh_token?: string
}

function refreshSession(version: number, refreshToken: string): Promise<void> {
  if (pendingRefresh?.version === version) return pendingRefresh.promise

  const promise = axios.post<ApiResponse<RefreshResponse>>('/api/v1/auth/refresh', {
    refresh_token: refreshToken,
  }).then(({ data: res }) => {
    if (!auth.refreshTokens(res.data.access_token, res.data.refresh_token ?? refreshToken, version, refreshToken)) {
      throw new CanceledError('Session changed')
    }
  }).catch((error: unknown) => {
    // A late refresh failure must not sign out a newer login.
    if (version === auth.getSessionVersion() && auth.getRefreshToken() === refreshToken) {
      auth.logout()
    }
    throw error
  }).finally(() => {
    if (pendingRefresh?.promise === promise) pendingRefresh = undefined
  })
  pendingRefresh = { version, promise }
  return promise
}

// All callers await the same promise, so refresh failure rejects every waiter.
api.interceptors.response.use(
  (response) => {
    if (sessionChanged(response.config as SessionRequestConfig)) {
      throw new CanceledError('Session changed')
    }
    return response
  },
  async (error: AxiosError) => {
    const original = error.config as SessionRequestConfig | undefined
    if (!original) throw error
    if (sessionChanged(original)) throw new CanceledError('Session changed')
    if (error.response?.status !== 401 || publicAuthPaths.has(original.url ?? '')) throw error

    if (original._retry) {
      auth.logout()
      throw error
    }
    original._retry = true

    // Another request may have refreshed while this 401 was in flight.
    const currentAccess = auth.getAccessToken()
    if (currentAccess && original.headers.Authorization !== `Bearer ${currentAccess}`) {
      return api(original)
    }

    if (auth.hasSsoSession()) {
      if (await auth.restoreSsoSession() && !sessionChanged(original)) return api(original)
      throw new CanceledError('Session changed')
    }

    const refreshToken = auth.getRefreshToken()
    if (!refreshToken) {
      auth.logout()
      throw error
    }
    await refreshSession(auth.getSessionVersion(), refreshToken)
    if (sessionChanged(original)) throw new CanceledError('Session changed')
    return api(original)
  },
)

export default api

// ─── Async jobs (spec 2026-09-09 §5.1) ────────────────────────────────────────

import type { AccountJob, Paginated, PageParams } from '../types'

export interface ListJobsParams {
  kind?: string
  status?: string
  cloud_account_id?: string
  active?: boolean
  limit?: number
}

export async function listJobs(orgId: string, params: ListJobsParams = {}): Promise<AccountJob[]> {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  const { data: res } = await api.get<{ data: AccountJob[] }>(
    `/orgs/${orgId}/jobs${query ? `?${query}` : ''}`,
  )
  return res.data ?? []
}

export async function getJob(orgId: string, jobId: string): Promise<AccountJob> {
  const { data: res } = await api.get<{ data: AccountJob }>(`/orgs/${orgId}/jobs/${jobId}`)
  return res.data
}

export async function cancelJob(orgId: string, jobId: string): Promise<AccountJob> {
  const { data: res } = await api.post<{ data: AccountJob }>(`/orgs/${orgId}/jobs/${jobId}/cancel`)
  return res.data
}

// ─── Pagination ────────────────────────────────────────────────────────────────

/**
 * The one sanctioned way to call a paginated list endpoint. Sends
 * `?page=&per_page=` plus any filters, returns the `{data, meta}` envelope.
 */
export async function paginatedGet<T>(
  path: string,
  params: PageParams & Record<string, unknown> = {},
): Promise<Paginated<T>> {
  const { data } = await api.get<Paginated<T>>(path, { params })
  return data
}
