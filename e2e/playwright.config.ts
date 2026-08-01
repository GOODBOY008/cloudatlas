import { defineConfig, devices } from '@playwright/test';

/**
 * CloudAtlas E2E Playwright configuration.
 *
 * Environment variables:
 *   E2E_BASE_URL    - Frontend URL (default: http://localhost:5173)
 *   E2E_API_URL     - Backend API URL (default: http://localhost:8080)
 *   E2E_ADMIN_EMAIL - Admin email (default: admin@acme.com)
 *   E2E_ADMIN_PASS  - Admin password (default: admin123)
 *   CI              - Set by GitHub Actions; changes reporters, retries, workers
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  /* Maximum time one test can run */
  timeout: 45_000,
  /* Global timeout for the whole test suite */
  globalTimeout: 30 * 60_000,
  expect: { timeout: 10_000 },

  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if test.only is left in source */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Use 1 worker on CI to avoid port/state conflicts, 4 locally */
  /* Run serially — the dev stack (Vite + API) struggles under 4 parallel
   * browsers and produces load-related flakes; CI already uses 1 worker. */
  workers: 1,

  /* Reporter configuration */
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ...(process.env.CI
      ? [['github'] as ['github'], ['json', { outputFile: 'test-results/results.json' }] as ['json', { outputFile: string }]]
      : []),
  ],

  use: {
    baseURL: BASE_URL,
    /* Collect trace on first retry */
    trace: 'on-first-retry',
    /* Take screenshot on failure */
    screenshot: 'only-on-failure',
    /* Record video on retry */
    video: 'on-first-retry',
    /* Viewport */
    viewport: { width: 1280, height: 800 },
    /* Navigation timeout */
    navigationTimeout: 20_000,
    /* Ignore HTTPS errors in test environments */
    ignoreHTTPSErrors: true,
  },

  projects: [
    /* Setup project — runs global-setup.ts to pre-authenticate */
    {
      name: 'setup',
      testDir: '.',
      testMatch: /global-setup\.ts/,
    },

    /* Chromium (primary) */
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /* Reuse auth state from setup */
        storageState: 'playwright/.auth/user.json',
      },
      dependencies: ['setup'],
    },

    /* Firefox */
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        storageState: 'playwright/.auth/user.json',
      },
      dependencies: ['setup'],
    },

    /* WebKit (Safari) — only on CI when full matrix needed */
    ...(process.env.CI
      ? [
          {
            name: 'webkit',
            use: {
              ...devices['Desktop Safari'],
              storageState: 'playwright/.auth/user.json',
            },
            dependencies: ['setup'],
          },
        ]
      : []),

    /* Mobile smoke: only on CI */
    ...(process.env.CI
      ? [
          {
            name: 'mobile-chrome',
            use: {
              ...devices['Pixel 5'],
              storageState: 'playwright/.auth/user.json',
            },
            dependencies: ['setup'],
            testMatch: /smoke\.spec\.ts/,
          },
        ]
      : []),
  ],

  /* Run local dev server automatically when not in CI */
  ...(!process.env.CI && {
    webServer: [
      {
        command: 'cd .. && npm --prefix frontend run dev',
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 60_000,
      },
    ],
  }),

  /* Output directory for test artifacts */
  outputDir: 'test-results/',
});
