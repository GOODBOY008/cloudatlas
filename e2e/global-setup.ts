/**
 * Global setup: authenticates once and persists the browser storage state.
 * All test projects reuse playwright/.auth/user.json — no repeated logins.
 */
import { test as setup, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@acme.com';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS ?? 'Password123!';
const AUTH_FILE = path.join(__dirname, 'playwright/.auth/user.json');

setup('authenticate', async ({ page }) => {
  // Ensure auth directory exists
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  // Navigate to login
  await page.goto(`${BASE_URL}/login`);

  // Wait for the login form
  await page.waitForSelector('input[type="password"]', { timeout: 20_000 });

  // Fill credentials
  const emailInput = page.locator('input[type="text"], input[type="email"], input[placeholder*="email" i]').first();
  await emailInput.fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').first().fill(ADMIN_PASS);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Wait for successful redirect to dashboard
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });

  // Verify token is present in localStorage
  const token = await page.evaluate(() => localStorage.getItem('ca_access_token'));
  expect(token).toBeTruthy();

  // Save the authenticated state
  await page.context().storageState({ path: AUTH_FILE });

  console.log(`✓ E2E global setup: authenticated as ${ADMIN_EMAIL}`);
});
