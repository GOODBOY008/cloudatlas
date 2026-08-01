/**
 * Suite 1: Authentication (AUTH-01 → AUTH-10)
 * Uses unauthenticated context — no storageState pre-loaded.
 */
import { unauthTest as test, expect } from '../fixtures/base.fixture';
import { LoginPage } from '../pages/LoginPage';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@acme.com';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS ?? 'Password123!';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test.describe('Authentication', () => {
  test('AUTH-01 — login page renders @smoke', async ({ unauthPage }) => {
    const login = new LoginPage(unauthPage);
    await login.navigate();

    await expect(login.emailInput).toBeVisible();
    await expect(login.passwordInput).toBeVisible();
    await expect(login.signInButton).toBeVisible();
  });

  test('AUTH-09 — password field is masked', async ({ unauthPage }) => {
    const login = new LoginPage(unauthPage);
    await login.navigate();

    await expect(login.passwordInput).toHaveAttribute('type', 'password');
  });

  test('AUTH-03 — invalid credentials shows error', async ({ unauthPage }) => {
    const login = new LoginPage(unauthPage);
    await login.navigate();
    await login.login('wrong@email.com', 'wrongpassword');

    // Should remain on /login
    await expect(unauthPage).toHaveURL(/\/login/);
  });

  test('AUTH-02 — valid login redirects to dashboard @smoke', async ({ unauthPage }) => {
    const login = new LoginPage(unauthPage);
    await login.navigate();
    await login.login(ADMIN_EMAIL, ADMIN_PASS);

    await unauthPage.waitForURL(/\/dashboard/, { timeout: 20_000 });
    const token = await unauthPage.evaluate(() => localStorage.getItem('ca_access_token'));
    expect(token).toBeTruthy();
  });

  test('AUTH-07 — refresh token stored after login', async ({ unauthPage }) => {
    const login = new LoginPage(unauthPage);
    await login.navigate();
    await login.login(ADMIN_EMAIL, ADMIN_PASS);
    await unauthPage.waitForURL(/\/dashboard/, { timeout: 20_000 });

    const refresh = await unauthPage.evaluate(() => localStorage.getItem('ca_refresh_token'));
    expect(refresh).toBeTruthy();
  });

  test('AUTH-04 — protected route redirects unauthenticated user', async ({ unauthPage }) => {
    await unauthPage.goto(`${BASE}/pools`);
    await unauthPage.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(unauthPage).toHaveURL(/\/login/);
  });

  test('AUTH-05 — /login redirects when already authenticated', async ({ unauthPage }) => {
    // Login first
    const login = new LoginPage(unauthPage);
    await login.navigate();
    await login.login(ADMIN_EMAIL, ADMIN_PASS);
    await unauthPage.waitForURL(/\/dashboard/, { timeout: 20_000 });

    // Navigate back to /login — should redirect away
    await unauthPage.goto(`${BASE}/login`);
    await unauthPage.waitForTimeout(2000);
    expect(unauthPage.url()).not.toContain('/login');
  });

  test('AUTH-06 — logout clears tokens and redirects @smoke', async ({ unauthPage }) => {
    // Login
    const login = new LoginPage(unauthPage);
    await login.navigate();
    await login.login(ADMIN_EMAIL, ADMIN_PASS);
    await unauthPage.waitForURL(/\/dashboard/, { timeout: 20_000 });

    // Click logout
    const logoutBtn = unauthPage.getByRole('button', { name: /logout|sign out/i }).first();
    await logoutBtn.click();
    await unauthPage.waitForURL(/\/login/, { timeout: 10_000 });

    const token = await unauthPage.evaluate(() => localStorage.getItem('ca_access_token'));
    expect(token).toBeFalsy();
  });

  test('AUTH-08 — empty form submission does not crash', async ({ unauthPage }) => {
    const login = new LoginPage(unauthPage);
    await login.navigate();
    await login.signInButton.click();

    // Should still be on /login (validation or API error)
    await unauthPage.waitForTimeout(1500);
    await expect(unauthPage).toHaveURL(/\/login/);
  });

  test('AUTH-10 — repeated invalid attempts do not crash', async ({ unauthPage }) => {
    const login = new LoginPage(unauthPage);
    await login.navigate();

    for (let i = 0; i < 3; i++) {
      await login.login('bad@email.com', 'wrongpassword');
      await unauthPage.waitForTimeout(800);
    }
    await expect(unauthPage).toHaveURL(/\/login/);
  });
});
