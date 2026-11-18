import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Login from '../pages/Login'
import api from '../lib/api'
import { auth } from '../lib/auth'
import i18n from '../i18n'

vi.mock('../lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
const challenge = { isAxiosError: true, response: { status: 401, data: { error: {
  code: 'UNAUTHORIZED', message: 'Two-factor code is required or invalid',
} } } }

function renderLogin() {
  return render(<MemoryRouter initialEntries={['/login']}><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/dashboard" element={<p>Signed in successfully</p>} />
  </Routes></MemoryRouter>)
}

function fillCredentials() {
  fireEvent.change(screen.getByLabelText(i18n.t('login.email')), { target: { value: 'alice@example.com' } })
  fireEvent.change(screen.getByLabelText(i18n.t('login.password')), { target: { value: 'Password123!' } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('login.signIn') }))
}

beforeEach(() => {
  vi.resetAllMocks()
  auth.clearTokens()
  vi.mocked(api.get).mockResolvedValue({ data: { data: { enabled: false } } })
})
afterEach(async () => { auth.clearTokens(); await i18n.changeLanguage('en') })

describe('two-factor sign in', () => {
  it.each(['en', 'zh'])('shows the challenge in %s and submits the code on retry', async language => {
    await i18n.changeLanguage(language)
    vi.mocked(api.post).mockRejectedValueOnce(challenge).mockResolvedValueOnce({ data: { data: {
      access_token: 'access-verified', refresh_token: 'refresh-verified',
    } } })
    renderLogin()
    expect(screen.queryByLabelText(i18n.t('login.totpCode'))).not.toBeInTheDocument()
    fillCredentials()
    const code = await screen.findByLabelText(i18n.t('login.totpCode'))
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('login.totpRequired'))
    expect(code).toHaveFocus()
    expect(auth.isAuthenticated()).toBe(false)
    fireEvent.change(code, { target: { value: '012345' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('login.signIn') }))
    expect(await screen.findByText('Signed in successfully')).toBeInTheDocument()
    expect(api.post).toHaveBeenLastCalledWith('/auth/login', {
      email: 'alice@example.com', password: 'Password123!', totp_code: '012345',
    })
    expect(auth.getAccessToken()).toBe('access-verified')
  })

  it('keeps the code input available after an invalid code, and resets it for a different account', async () => {
    vi.mocked(api.post).mockRejectedValue(challenge)
    renderLogin()
    fillCredentials()
    const code = await screen.findByLabelText('Two-factor code')
    fireEvent.change(code, { target: { value: '111111' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    expect(await screen.findByText(i18n.t('login.totpInvalid'))).toBeInTheDocument()
    expect(screen.getByLabelText('Two-factor code')).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bob@example.com' } })
    expect(screen.queryByLabelText('Two-factor code')).not.toBeInTheDocument()
  })

  it('does not expose arbitrary server messages or mistake infrastructure failures for invalid credentials', async () => {
    vi.mocked(api.post).mockRejectedValue({ isAxiosError: true, response: { status: 500, data: {
      error: { message: 'internal database connection detail' },
    } } })
    renderLogin()
    fillCredentials()
    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('login.error'))
    expect(screen.queryByText(/internal database/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Two-factor code')).not.toBeInTheDocument()
  })
})
