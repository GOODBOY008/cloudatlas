import axios, { AxiosError } from 'axios'
import { auth } from './auth'
import type { AuthResponse, ApiResponse } from '../types'

const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

// Attach Bearer token to every request
api.interceptors.request.use((config) => {
  const token = auth.getAccessToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

let isRefreshing = false
let refreshQueue: Array<(token: string) => void> = []

// Handle 401: attempt token refresh once, then redirect to login
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as typeof error.config & { _retry?: boolean }

    if (error.response?.status === 401 && !original?._retry) {
      const refreshToken = auth.getRefreshToken()
      if (!refreshToken) {
        auth.logout()
        return Promise.reject(error)
      }

      if (isRefreshing) {
        return new Promise((resolve) => {
          refreshQueue.push((newToken: string) => {
            if (original) {
              original.headers = original.headers ?? {}
              original.headers.Authorization = `Bearer ${newToken}`
              resolve(api(original))
            }
          })
        })
      }

      original!._retry = true
      isRefreshing = true

      try {
        const { data: res } = await axios.post<ApiResponse<AuthResponse>>('/api/v1/auth/refresh', {
          refresh_token: refreshToken,
        })
        auth.setTokens(res.data.access_token, res.data.refresh_token)
        refreshQueue.forEach((cb) => cb(res.data.access_token))
        refreshQueue = []
        if (original) {
          original.headers = original.headers ?? {}
          original.headers.Authorization = `Bearer ${res.data.access_token}`
          return api(original)
        }
      } catch {
        auth.logout()
        return Promise.reject(error)
      } finally {
        isRefreshing = false
      }
    }

    return Promise.reject(error)
  }
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
