# Quickstart — CloudAtlas in 10 Minutes

This guide takes you from a fresh clone to a running CloudAtlas with demo data, then verifies the install with a built-in smoke test. Every command here has been executed against a clean environment; if something fails, check [Troubleshooting](#troubleshooting).

> Prefer the full page-by-page manual? See the [User Guide](user-guide.md).
> Want the architecture? See [Architecture Design](design.md).

## What You'll Get

After this guide you will have:

- The full platform running: Rust API on `:8080`, web UI, PostgreSQL 15, background scheduler
- A seeded demo organization (**Acme Corp**) with 2 mock cloud accounts, resources, 30+ days of expenses, pools, and recommendations — no real cloud credentials needed
- Login credentials and a 5-minute tour of the main pages
- A verified install: health checks, an authenticated API walkthrough, and the smoke-test suite

## Prerequisites

| Tool | Version | Needed for | Check |
|------|---------|-----------|-------|
| Docker (+ Compose v2) | 24+ | Both paths | `docker compose version` |
| Rust (`rustup`) | 1.78+ | Local dev path | `cargo --version` |
| Node.js | 20+ | Local dev path | `node --version` |
| curl + python3 | any | Verification | `curl --version` |

Path A (Docker, ~10 min + first-build time) needs only Docker. Path B (local dev, hot reload) additionally needs Rust and Node.

---

## Path A — Docker Compose (recommended first run)

All four services — PostgreSQL, migrations, API, and the web UI — come up as one stack. The compose file ships self-contained dev defaults, so no `.env` is required for a local first run.

```bash
# 1. Clone
git clone https://github.com/GOODBOY008/cloudatlas.git
cd cloudatlas

# 2. Start the stack (PostgreSQL + migrations + API + web UI)
#    First build compiles the Rust backend in Docker — expect 10-30 min.
#    Subsequent builds hit the Docker layer cache and are fast.
docker compose up -d --build

# 3. Wait for the API to pass its health check (~30s after build)
docker compose ps   # api should show "healthy"
```

| Service | URL |
|---------|-----|
| Web UI | http://localhost:3000 |
| API | http://localhost:8080/api/v1 |
| Swagger UI | http://localhost:8080/swagger-ui/ |
| Health | http://localhost:8080/health |

That's it — skip to [Log in](#log-in).

<details>
<summary>Production notes (click to expand)</summary>

Before real use: create `.env` from `.env.example`, set a real `JWT_SECRET` (`openssl rand -hex 64`) and `ENCRYPTION_KEY` (`openssl rand -hex 32`), point `DATABASE_URL` at your PostgreSQL, and read the [Production Checklist](production-checklist.md).
</details>

---

## Path B — Local Development (hot reload)

Run PostgreSQL (and migrations) in Docker, but the backend and frontend natively so code changes reload instantly.

### 1. Start PostgreSQL

```bash
docker compose -f docker-compose.dev.yml up -d postgres
```

### 2. Configure environment

```bash
cp .env.example .env

# Replace the placeholder secrets with strong generated values
sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
```

Both keys are validated at API startup and it refuses to start on placeholders. The remaining defaults (`DATABASE_URL=postgres://cloudatlas:cloudatlas@localhost:5432/cloudatlas`, `CLOUD_MOCK_ENABLED=true`) are correct for this path. `cargo run` in step 4 picks up this repo-root `.env` automatically (the loader also searches parent directories).

### 3. Create the schema (migrations + seed data)

The API does **not** apply migrations itself — run the one-shot migrate container:

```bash
docker compose -f docker-compose.dev.yml build migrate    # picks up new migrations
docker compose -f docker-compose.dev.yml run --rm migrate
```

Expected output shows one `Applied N/<name>` line per migration (`Applied 26/migrate bugfix lifecycle enum resources unique type softdelete` at time of writing). Migration `007_seed.sql` creates the demo org and users.

### 4. Start the backend

```bash
cd backend
cargo run
```

Wait for `Listening on http://0.0.0.0:8080` in the logs (first compile takes a few minutes), then in a second terminal confirm:

```bash
curl -s http://localhost:8080/health
# {"status":"ok",...}
```

### 5. Start the frontend

In a third terminal:

```bash
cd frontend
npm install     # first time only
npm run dev
```

The Vite dev server proxies `/api` to `http://localhost:8080` by default. Open http://localhost:5173.

---

## Log in

Open the web UI (http://localhost:3000 for Path A, http://localhost:5173 for Path B) and sign in with a seeded user:

| User | Email | Password |
|------|-------|----------|
| Admin (org owner) | `admin@acme.com` | `Password123!` |
| Alice (member) | `alice@acme.com` | `Password123!` |
| Bob (member) | `bob@acme.com` | `Password123!` |

The UI is English/中文 — switch languages from the header on any page, including the login screen.

---

## Verify Your Install (smoke test)

Run these three checks in order. All three passing means the stack — database, migrations, seed data, auth, and the API surface — is fully working.

### 1. Health endpoints

```bash
curl -s http://localhost:8080/health | python3 -m json.tool
curl -s http://localhost:8080/health/ready | python3 -m json.tool
```

Expect `"status": "ok"` from both. Note: health lives at `/health`, **not** `/api/v1/health`.

### 2. Authenticated API walkthrough

```bash
# Log in and capture a token
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme.com","password":"Password123!"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["access_token"])')

echo "token length: ${#TOKEN}"   # non-zero = auth + seed users OK

# Read the demo org's cost summary (seeded expenses)
curl -s http://localhost:8080/api/v1/orgs/a0000000-0000-0000-0000-000000000001/expenses/summary \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expect a JSON body whose `data` contains a non-zero `total_cost` and a `by_service` breakdown led by `Amazon EC2` (from the seed data).

### 3. Full smoke-test suite

```bash
./scripts/smoke_test.sh
```

This exercises ~50 endpoints across health, auth, orgs, cloud accounts, CMDB, expenses, pools, recommendations, webhooks, constraints, and billing — creating throwaway records with a `smoke_` prefix. The final line should read:

```
TOTAL: <N> passed, 0 failed
```

---

## First Five Minutes — a Tour

1. **Dashboard** — month-to-date spend, 30-day trend with forecast, top resources, and pools needing attention. If the onboarding banner offers to load demo data, click it.

   ![Dashboard](screenshots/quickstart/quickstart-t2-dashboard.png)

2. **Recommendations** — press **Run Engine**, then browse the findings (idle instances, orphan volumes, rightsizing, …) with estimated monthly savings per item.

   ![Recommendations](screenshots/quickstart/quickstart-t3-recommendations.png)

3. **Cost Explorer** — slice the seeded spend by service, region, cloud account, or tag; click any bar or row to drill into resources.

   ![Cost Explorer](screenshots/quickstart/quickstart-t4-cost-explorer.png)

4. **Cost Map** — treemap and world-map views of spend distribution, plus unit economics and the pool budget matrix.

   ![Cost Map](screenshots/quickstart/quickstart-t5-cost-map.png)

5. **CMDB** — browse configuration items (instances, databases, volumes, buckets), open one for its topology, audit trail, and linked costs.

   ![CMDB](screenshots/quickstart/quickstart-t6-cmdb.png)

Every page above works on seed data alone — no cloud account connection required.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| API exits with `ENCRYPTION_KEY must be exactly 64 hexadecimal characters` | Placeholder key in `.env` | `openssl rand -hex 32` and paste the value |
| API exits with `JWT_SECRET must be at least 32 characters` | Short secret | `openssl rand -hex 32` and paste the value |
| `401` on every API call | Token missing/expired (1 h expiry) | Re-run the login step to capture a fresh `TOKEN` |
| Login returns 500/404 for seed users | Migrations never ran (the API doesn't apply them) | Run the migrate step (Path B step 3); on Path A check `docker compose logs migrate` |
| Migrate container says `no migration files were found` or misses new ones | Stale `cloudatlas-migrate` image | `docker compose -f docker-compose.dev.yml build migrate` then re-run |
| `/api/v1/health` returns 404 | Health isn't under `/api/v1` | Use `http://localhost:8080/health` |
| `curl: (7) Failed to connect` on :8080 | Backend still compiling or crashed | Check `docker compose logs api` (Path A) or the `cargo run` terminal (Path B) |
| Frontend shows network errors in the browser console | API not reachable at the expected origin | Path A uses `:3000`; Path B's Vite proxy targets `localhost:8080` (override with `VITE_PROXY_TARGET`) |
| Port already in use (5432/8080/3000/5173) | Another stack still running | `docker compose down` / stop the native process; dev and prod stacks can't run at the same time |
| Docker build fails on `cargo chef cook` | Out-of-disk or cancelled layer cache | `docker system prune` and rebuild |

**Start completely over** (drops all data):

```bash
# Path A
docker compose down -v
# Path B
docker compose -f docker-compose.dev.yml down -v
```

Then repeat the setup steps above.

---

## Next Steps

- **User Guide** — every page explained: [user-guide.md](user-guide.md)
- **API recipes** — copy-paste `curl` workflows: [api-examples.md](api-examples.md)
- **Connect a real cloud** — Cloud Accounts → Add Account (AWS or Alibaba Cloud; mock accounts work everywhere else). Real providers (AWS / Alibaba / Azure / GCP) require their credential fields (Access Key + Secret, etc.) in the form; demo/"Other" accounts need only an External ID. Credentials are encrypted at rest and can be rotated or cleared later from the account's Edit dialog. Alibaba discovery now covers ECS instances/disks/snapshots, RDS, SLB/ALB/NLB, EIPs and OSS buckets — the RAM user needs read access for all of those plus BSS (`ecs:DescribeSnapshots`, `vpc:DescribeEipAddresses`, `oss:ListBuckets`, `alb`/`nlb:DescribeLoadBalancers`, `bss:DescribeInstanceBill`); see the design spec §7 for the exact policy.
- **Kubernetes accounts** — Cloud Accounts → Add Account → Kubernetes takes a `server` URL (https) + service-account bearer `token` (ClusterRole `view` is enough for reads). Discovery fetches nodes, pods and workloads (Deployment/StatefulSet/DaemonSet/Job/CronJob); optional `config.namespace` scopes it. **metrics-server is optional but required for P95 rightsizing** — without it the K8s Rightsizing page shows workloads without usage/P95/recommendations. Cost assumptions come from `config.cpu_hourly_cost` / `config.memory_hourly_cost` (defaults 0.04 / 0.005 USD per vCPU-hour / GiB-hour); sync is triggered by the hourly scheduler or the per-account "Sync now" button, and usage samples accumulate in `k8s_usage_samples` for a rolling 14-day P95 window.
- **AI features** (optional) — set `AI_ENABLED=true` + `OPENAI_API_KEY`, or configure an OpenAI-compatible provider in **Settings → AI**
- **Go to production** — [production-checklist.md](production-checklist.md)
