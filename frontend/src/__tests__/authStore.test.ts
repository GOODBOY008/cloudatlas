import { describe, it, expect, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { useAuthStore } from '../store/authStore'

const mockUser = {
  id: 'user-001',
  display_name: 'Alice Test',
  email: 'alice@cloudatlas.dev',
}

describe('authStore', () => {
  beforeEach(() => {
    act(() => {
      useAuthStore.getState().clearAuth()
    })
  })

  it('starts unauthenticated', () => {
    const { user, accessToken, isAuthenticated } = useAuthStore.getState()
    expect(user).toBeNull()
    expect(accessToken).toBeNull()
    expect(isAuthenticated()).toBe(false)
  })

  it('sets auth state on setAuth', () => {
    act(() => {
      useAuthStore.getState().setAuth(mockUser, 'access_token_abc', 'refresh_token_xyz')
    })
    const state = useAuthStore.getState()
    expect(state.user).toEqual(mockUser)
    expect(state.accessToken).toBe('access_token_abc')
    expect(state.refreshToken).toBe('refresh_token_xyz')
    expect(state.isAuthenticated()).toBe(true)
  })

  it('clears auth state on clearAuth', () => {
    act(() => {
      useAuthStore.getState().setAuth(mockUser, 'tok', 'ref')
    })
    act(() => {
      useAuthStore.getState().clearAuth()
    })
    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.accessToken).toBeNull()
    expect(state.isAuthenticated()).toBe(false)
  })

  it('isAuthenticated returns false when token is null', () => {
    expect(useAuthStore.getState().isAuthenticated()).toBe(false)
  })
})
