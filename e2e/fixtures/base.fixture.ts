/**
 * Base fixture that extends Playwright's test with:
 * - Pre-authenticated page (via storageState)
 * - Page Object helpers attached to every test
 * - API client for seeding / teardown
 */
import { test as base, expect, Page } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { PoolsPage } from '../pages/PoolsPage';
import { CloudAccountsPage } from '../pages/CloudAccountsPage';
import { CmdbPage } from '../pages/CmdbPage';
import { ExpensesPage } from '../pages/ExpensesPage';
import { RecommendationsPage } from '../pages/RecommendationsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ApiClient } from '../helpers/api';

type CloudAtlasFixtures = {
  loginPage: LoginPage;
  dashboardPage: DashboardPage;
  poolsPage: PoolsPage;
  cloudAccountsPage: CloudAccountsPage;
  cmdbPage: CmdbPage;
  expensesPage: ExpensesPage;
  recommendationsPage: RecommendationsPage;
  settingsPage: SettingsPage;
  api: ApiClient;
};

export const test = base.extend<CloudAtlasFixtures>({
  loginPage: async ({ page }, use) => use(new LoginPage(page)),
  dashboardPage: async ({ page }, use) => use(new DashboardPage(page)),
  poolsPage: async ({ page }, use) => use(new PoolsPage(page)),
  cloudAccountsPage: async ({ page }, use) => use(new CloudAccountsPage(page)),
  cmdbPage: async ({ page }, use) => use(new CmdbPage(page)),
  expensesPage: async ({ page }, use) => use(new ExpensesPage(page)),
  recommendationsPage: async ({ page }, use) => use(new RecommendationsPage(page)),
  settingsPage: async ({ page }, use) => use(new SettingsPage(page)),
  api: async ({ request }, use) => use(new ApiClient(request)),
});

/**
 * Unauthenticated fixture — clears storage state before each test.
 * Use for auth-flow tests (login, logout, redirect checks).
 */
export const unauthTest = base.extend<{ unauthPage: Page }>({
  unauthPage: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: undefined });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
});

export { expect };
