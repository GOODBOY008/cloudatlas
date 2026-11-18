export const SSO_COMPLETE_PATH = '/auth/oidc/complete'

/** Only accept app-local return paths supplied by the protected route guard. */
export function loginRedirect(from: unknown): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || /[\\\u0000-\u001f]/.test(from)) {
    return '/dashboard'
  }
  const path = from.split(/[?#]/, 1)[0]
  return path === '/login' || path === '/reset-password' || path === SSO_COMPLETE_PATH ? '/dashboard' : from
}
export const LOGIN_RETURN_PATH_KEY = 'cloudatlas-login-return-path'
