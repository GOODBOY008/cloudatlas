# CloudAtlas E2E Test Platform

> Playwright-based end-to-end tests for CloudAtlas routes, workflows, navigation, and the shared design system.

## Quick start

```bash
# Install Playwright + browsers
make e2e-install

# Start the dev stack (in another terminal)
make dev

# Run all tests
make e2e

# Run smoke tests only (~2 min)
make e2e-smoke

# Open interactive Playwright UI
make e2e-ui

# Open last HTML report
make e2e-report
```

## Directory structure

```
e2e/
├── playwright.config.ts        # Project config (browsers, retries, reporters)
├── global-setup.ts             # Pre-authenticates and saves auth state
├── fixtures/
│   └── base.fixture.ts         # Extended test fixtures with page objects
├── pages/                      # Page Object Models
│   ├── BasePage.ts
│   ├── LoginPage.ts
│   ├── DashboardPage.ts
│   ├── PoolsPage.ts
│   ├── CloudAccountsPage.ts
│   ├── CmdbPage.ts
│   ├── ExpensesPage.ts
│   ├── RecommendationsPage.ts
│   └── SettingsPage.ts
├── tests/
│   ├── smoke.spec.ts           # @smoke — critical path, fast
│   ├── auth.spec.ts            # AUTH-01 → AUTH-10
│   ├── navigation.spec.ts      # NAV-01 → NAV-12
│   ├── theme.spec.ts           # Theme persistence, focus, mobile layout, Chinese labels
│   ├── pages.spec.ts           # PAGE-01 → PAGE-34 (all routes)
│   ├── dashboard.spec.ts       # DASH + EXP tabs
│   ├── pools.spec.ts           # POOL CRUD
│   └── crud.spec.ts            # Cloud Accounts, Recs, Settings, CMDB
└── helpers/
    └── api.ts                  # API client for setup/teardown
```

## Test tags

| Tag | Description | Command |
|---|---|---|
| `@smoke` | Critical path, runs every PR (~2 min) | `make e2e-smoke` |
| `@regression` | Full suite, runs on main + nightly | `make e2e-regression` |

## Design system regression checks

With the frontend and API running, use this focused suite after changing the shared theme or application shell:

```bash
cd e2e
npx playwright test tests/theme.spec.ts tests/navigation.spec.ts tests/dashboard.spec.ts tests/smoke.spec.ts --project=chromium
```

`theme.spec.ts` covers the default light theme and saved dark preference, global search keyboard focus and dismissal, account-dialog autofocus and launcher focus restoration, mobile navigation and overflow, and Chinese dashboard labels. Navigation tests expand the relevant sidebar sections before following links. Dashboard tab tests scope tab selectors to the main content so sidebar section buttons cannot be mistaken for tabs.

Also inspect representative charts, tables, forms, and dialogs in both themes and at a narrow viewport. Keep documented key bindings in sync with the [system keyboard shortcuts](../docs/user-guide.md#system-keyboard-shortcuts).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:5173` | Frontend URL |
| `E2E_API_URL` | `http://localhost:8080` | Backend API URL |
| `E2E_ADMIN_EMAIL` | `admin@acme.com` | Admin login email |
| `E2E_ADMIN_PASS` | `admin123` | Admin login password |

## Running in Docker (CI equivalent)

```bash
make e2e-docker
```

This spins up the full stack (`postgres → migrate → api → frontend`) plus a Playwright runner container, runs all tests, then tears everything down.

## GitHub CI integration

| Workflow trigger | Tests run |
|---|---|
| Every push / PR to `main`/`develop` | `@smoke` (chromium) |
| Merge to `main` | Full regression (chromium + firefox) |
| Nightly schedule (02:00 UTC) | Full regression (chromium + firefox) |
| `workflow_dispatch` | Configurable suite + browser |

Test artifacts (HTML report, screenshots, traces) are uploaded as GitHub Actions artifacts and retained for 7–14 days.
