# CloudAtlas E2E Test Platform

> Playwright-based end-to-end test suite covering all 34 routes, 11 test suites, and 100+ test cases.

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
