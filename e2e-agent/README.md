# CloudAtlas — AI Agent E2E Tests

Autonomous end-to-end testing powered by **Claude + Playwright**.

Instead of brittle scripted selectors, an AI agent reads each test scenario in natural language, decides what to click/type/verify, drives a real Chromium browser, and judges pass/fail from the evidence it collects — including screenshots.

---

## How it works

```
Test Scenario (natural language goal)
         │
         ▼
  Claude claude-3-5-sonnet  ←──────────────┐
  (tool-calling loop)                       │
         │                                  │
         ▼                                  │
  Tool: navigate / click /            Tool results
        fill / assert / screenshot     (text + images)
         │
         ▼
  Playwright (Chromium)  →  Real browser
         │
         ▼
  finish_test(passed, summary)
         │
         ▼
  HTML + JSON report
```

Each test scenario is a paragraph of plain English. The agent:
1. Reads the goal
2. Calls browser tools (navigate, click, fill, assert_visible, screenshot…)
3. Visually inspects screenshots when needed (vision model)
4. Calls `finish_test` with pass/fail + a summary

---

## Quick start

### 1. Prerequisites

- Node.js 18+
- CloudAtlas frontend running at `http://localhost:5173`
- CloudAtlas backend running at `http://localhost:8080`
- An [Anthropic API key](https://console.anthropic.com/settings/keys)

### 2. Install

```bash
# From the cloudatlas/ root
make agent-install

# Or directly
cd e2e-agent && npm install && npx playwright install chromium
```

### 3. Configure

```bash
cp e2e-agent/.env.example e2e-agent/.env
# Edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Start the app

```bash
# Terminal 1: start full dev stack
make dev

# Or just PostgreSQL + run backend and frontend separately
make dev-db
make dev-backend   # (in another terminal)
make dev-frontend  # (in another terminal)
```

### 5. Run tests

```bash
# Smoke tests only (fastest, ~5 min, 8 scenarios)
make agent-smoke

# Full suite
make agent-e2e

# Specific suite
make agent-auth
make agent-finops
make agent-cmdb

# Run in a visible browser (great for debugging)
make agent-headed

# List all scenarios
make agent-list

# Open HTML report after run
make agent-report
```

---

## Directory structure

```
e2e-agent/
├── package.json                # @anthropic-ai/sdk + playwright
├── tsconfig.json
├── .env.example                # Copy to .env and add your API key
├── src/
│   ├── index.ts                # CLI entry point
│   ├── agent.ts                # Claude tool-calling loop
│   ├── browser.ts              # Playwright-backed tool implementations
│   ├── tools.ts                # Claude tool definitions (schemas)
│   ├── reporter.ts             # HTML + JSON report generator
│   ├── types.ts                # Shared TypeScript interfaces
│   └── scenarios/
│       ├── index.ts            # Scenario registry + filter helpers
│       ├── auth.ts             # AUTH-01…AUTH-05
│       ├── dashboard.ts        # DASH-01…DASH-03
│       ├── finops.ts           # FIN-01…FIN-10
│       ├── cmdb.ts             # CMDB-01…CMDB-08
│       └── navigation.ts       # NAV-01…NAV-04
├── reports/                    # Generated HTML + JSON reports
│   └── latest.html             # Symlink to most recent
└── screenshots/                # Per-scenario screenshots (git-ignored)
```

---

## Scenarios

| ID | Suite | Name | Tags |
|---|---|---|---|
| AUTH-01 | auth | Login page renders | smoke |
| AUTH-02 | auth | Valid login redirects to dashboard | smoke |
| AUTH-03 | auth | Invalid credentials show error | auth |
| AUTH-04 | auth | Protected route redirects unauthenticated user | auth |
| AUTH-05 | auth | JWT token is stored after login | auth |
| DASH-01 | dashboard | Dashboard loads with stat cards | smoke |
| DASH-02 | dashboard | Dashboard navigation links work | dashboard |
| DASH-03 | dashboard | Dashboard shows data | dashboard |
| FIN-01 | finops | Expenses page loads with charts | smoke |
| FIN-02 | finops | Expenses tabs are navigable | finops |
| FIN-03 | finops | Pools page shows pool hierarchy | smoke |
| FIN-04 | finops | Create a new pool | regression |
| FIN-05 | finops | Cloud accounts page shows accounts | smoke |
| FIN-06 | finops | Add cloud account modal opens | finops |
| FIN-07 | finops | Recommendations page loads | smoke |
| FIN-08 | finops | Recommendations filter by type | finops |
| FIN-09 | finops | Cost Map page loads | finops |
| FIN-10 | finops | Alerts page loads | finops |
| CMDB-01 | cmdb | CMDB page loads with CI list | smoke |
| CMDB-02 | cmdb | CMDB search / filter works | cmdb |
| CMDB-03 | cmdb | CI detail drawer opens | cmdb |
| CMDB-04 | cmdb | Services page loads | cmdb |
| CMDB-05 | cmdb | Dynamic Groups page loads | cmdb |
| CMDB-06 | cmdb | Compliance page loads | cmdb |
| CMDB-07 | cmdb | CI Classifications page loads | cmdb |
| CMDB-08 | cmdb | CMDB Audit Log page loads | cmdb |
| CMDB-09 | cmdb | Inventory Stats page loads (renamed from CMDB Stats) | cmdb, regression |
| CMDB-10 | cmdb | Apply Rules page loads (now in Governance section) | cmdb, regression |
| NAV-01 | navigation | Sidebar navigation renders | smoke |
| NAV-02 | navigation | Theme toggle switches modes | navigation |
| NAV-03 | navigation | All major pages are reachable | regression |
| NAV-04 | navigation | Settings shows org info | navigation |
| NAV-05 | navigation | Renamed sidebar labels are visible | regression |

> **Sidebar note (2026-06-01 redesign)**: The sidebar was restructured into six labeled sections (Overview, Cost Management, Resource Management, Asset Inventory, Governance, Administration). Several items were renamed — the route paths are unchanged, only the display labels differ:
> - `Home` → `Dashboard`
> - `CMDB` → `Configuration Items`
> - `CMDB Stats` → `Inventory Stats`
> - `Quotas & Budgets` → `Budgets & Quotas`
> - `Tagging` → `Tagging Coverage`
> The `Sandbox` and `Policies` sections were eliminated; their items were redistributed. `/cmdb-audit` (Audit Log) is no longer in the sidebar but the route is preserved.

---

## Adding a new scenario

Edit `src/scenarios/*.ts` and add to the array:

```typescript
{
  id: 'FIN-11',
  name: 'Export expenses as CSV',
  suite: 'finops',
  tags: ['regression', 'finops'],
  goal: `Navigate to /expenses. Look for an "Export" or "Download CSV" button.
Click it. Verify a file download starts or a success message appears.
Pass if export triggered, fail if button not found.`,
}
```

The goal field is pure natural language — no selectors, no code. The agent figures out the implementation.

---

## CLI options

```
npx tsx src/index.ts [options]

  --suite <name>       Run specific suite: auth | dashboard | finops | cmdb | navigation
  --tags <list>        Filter by tags (e.g. --tags smoke)
  --ids <list>         Run specific IDs (e.g. --ids AUTH-01,CMDB-03)
  --headed             Run browser visibly (default: headless)
  --slow-mo <ms>       Slow down actions by <ms> milliseconds
  --concurrency <n>    Parallel scenarios (default: 1)
  --list               List all scenarios and exit
  --help               Show help
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `AGENT_MODEL` | `claude-3-5-sonnet-20241022` | Claude model to use |
| `AGENT_BASE_URL` | `http://localhost:5173` | Frontend URL |
| `AGENT_API_URL` | `http://localhost:8080` | Backend API URL |
| `AGENT_ADMIN_EMAIL` | `admin@acme.com` | Admin login email |
| `AGENT_ADMIN_PASS` | `Password123!` | Admin login password |
| `AGENT_MAX_STEPS` | `40` | Max tool calls per scenario |
| `AGENT_HEADLESS` | `true` | Set to `false` for headed mode |

---

## Cost estimate

Each scenario uses ~5-15 API calls to Claude. With `claude-3-5-sonnet`:
- Smoke suite (8 scenarios): ~$0.10–0.30
- Full suite (30 scenarios): ~$0.50–1.50

Screenshots are passed as images when taken, which increases token usage slightly but gives the agent visual awareness.

---

## Troubleshooting

**`ANTHROPIC_API_KEY is not set`** — Copy `.env.example` to `.env` and add your key.

**`Pre-authentication failed`** — Make sure the frontend is running at port 5173 and the seed user `admin@acme.com / Password123!` exists.

**Scenario times out** — Increase `AGENT_MAX_STEPS` or run with `--slow-mo 500` to see what's happening. Use `--headed` to watch the browser.

**`Cannot find module`** — Run `npm install` in the `e2e-agent/` directory.
