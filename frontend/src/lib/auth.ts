import axios from 'axios'
import { useAuthStore } from '../store/authStore'
import { useOrgStore } from '../store/orgStore'
import { useCopilotStore } from '../store/copilotStore'
import { setOrgCurrency } from './format'
import { queryClient } from './queryClient'
import type { ApiResponse } from '../types'

const ACCESS_TOKEN_KEY = 'ca_access_token'
const REFRESH_TOKEN_KEY = 'ca_refresh_token'
const SSO_SESSION_KEY = 'ca_sso_session'
const SSO_SESSION_ENDPOINT = '/api/v1/auth/oidc/session'
const SSO_REQUEST_TIMEOUT = 10_000
let sessionVersion = 0
let ssoSessionId = localStorage.getItem(SSO_SESSION_KEY)
let pendingSso: { version: number; expectedId: string | null; promise: Promise<boolean> } | undefined

// Existing password sessions use these keys. Reconcile the reactive store
// on startup so a stale, independently persisted authStore cannot sign us in.
const accessToken = ssoSessionId ? null : localStorage.getItem(ACCESS_TOKEN_KEY)
const refreshToken = ssoSessionId ? null : localStorage.getItem(REFRESH_TOKEN_KEY)
useAuthStore.setState({
  accessToken,
  refreshToken,
  user: accessToken && accessToken === useAuthStore.getState().accessToken
    ? useAuthStore.getState().user : null,
})

function clearSessionData() {
  // clear() cancels active queries before removing the query and mutation cache.
  queryClient.clear()
  useOrgStore.getState().clearOrg()
  useCopilotStore.getState().setOpen(false)
  setOrgCurrency('USD')
}

function persistTokens(access: string, refresh: string) {
  localStorage.setItem(ACCESS_TOKEN_KEY, access)
  localStorage.setItem(REFRESH_TOKEN_KEY, refresh)
  useAuthStore.setState({ accessToken: access, refreshToken: refresh })
}

interface SsoSessionResponse {
  session_id: string
  access_token: string
}

function requestSsoSession(expectedId: string | null): Promise<boolean> {
  const version = sessionVersion
  if (pendingSso?.version === version && pendingSso.expectedId === expectedId) return pendingSso.promise

  const promise = axios.post<ApiResponse<SsoSessionResponse>>(
    SSO_SESSION_ENDPOINT,
    { session_id: expectedId },
    { timeout: SSO_REQUEST_TIMEOUT },
  ).then(({ data: response }) => {
    if (version !== sessionVersion) return false
    const { session_id, access_token } = response.data
    if (!session_id || !access_token) throw new Error('Incomplete SSO session response')
    if (expectedId && session_id !== expectedId) {
      auth.clearTokens()
      return false
    }
    if (!expectedId) {
      auth.clearTokens()
      localStorage.removeItem(ACCESS_TOKEN_KEY)
      localStorage.removeItem(REFRESH_TOKEN_KEY)
      ssoSessionId = session_id
      localStorage.setItem(SSO_SESSION_KEY, session_id)
    }
    useAuthStore.setState({ accessToken: access_token, refreshToken: null })
    return true
  }).catch((error: unknown) => {
    if (version !== sessionVersion) return false
    if (!axios.isAxiosError(error) || error.response?.status !== 401) throw error
    if (expectedId) auth.clearTokens()
    return false
  }).finally(() => {
    if (pendingSso?.promise === promise) pendingSso = undefined
  })
  pendingSso = { version, expectedId, promise }
  return promise
}

export const auth = {
  getAccessToken(): string | null {
    return ssoSessionId ? useAuthStore.getState().accessToken : localStorage.getItem(ACCESS_TOKEN_KEY)
  },

  getRefreshToken(): string | null {
    return ssoSessionId ? null : localStorage.getItem(REFRESH_TOKEN_KEY)
  },

  getSessionVersion(): number {
    return sessionVersion
  },

  /** Begin a password session; never reuse another user's workspace or cache. */
  setTokens(accessToken: string, refreshToken: string): void {
    auth.clearTokens()
    localStorage.removeItem(SSO_SESSION_KEY)
    persistTokens(accessToken, refreshToken)
  },

  hasSsoSession(): boolean {
    return ssoSessionId !== null
  },

  completeSsoSignIn(): Promise<boolean> {
    return requestSsoSession(null)
  },

  restoreSsoSession(): Promise<boolean> {
    return ssoSessionId ? requestSsoSession(ssoSessionId) : Promise.resolve(false)
  },

  /** Rotate tokens only while the session that requested them is still active. */
  refreshTokens(access: string, refresh: string, version: number, previousRefresh: string): boolean {
    if (version !== sessionVersion || auth.getRefreshToken() !== previousRefresh) return false
    persistTokens(access, refresh)
    return true
  },

  clearTokens(): void {
    sessionVersion += 1
    if (ssoSessionId) {
      if (localStorage.getItem(SSO_SESSION_KEY) === ssoSessionId) localStorage.removeItem(SSO_SESSION_KEY)
    } else {
      localStorage.removeItem(ACCESS_TOKEN_KEY)
      localStorage.removeItem(REFRESH_TOKEN_KEY)
    }
    ssoSessionId = null
    useAuthStore.getState().clearAuth()
    clearSessionData()
  },

  isAuthenticated(): boolean {
    return !!auth.getAccessToken()
  },

  async signOut(): Promise<boolean> {
    const version = sessionVersion
    if (ssoSessionId) {
      await axios.delete(SSO_SESSION_ENDPOINT, {
        data: { session_id: ssoSessionId },
        timeout: SSO_REQUEST_TIMEOUT,
      })
    }
    if (version !== sessionVersion) return false
    auth.clearTokens()
    return true
  },

  logout(): void {
    auth.clearTokens()
    window.location.href = '/login'
  },
}

// The access token is tab-local. Drop it when another tab signs out or
// replaces the shared cookie session so background work cannot use it.
window.addEventListener('storage', (event) => {
  if (ssoSessionId && (event.key === SSO_SESSION_KEY || event.key === null)
    && localStorage.getItem(SSO_SESSION_KEY) !== ssoSessionId) {
    auth.clearTokens()
  }
})
