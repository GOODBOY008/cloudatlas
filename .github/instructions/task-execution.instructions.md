---
description: "Use when implementing tasks from TASKS.md or AGENTS.md for CloudAtlas, executing the build-and-validate workflow, running Docker Compose, checking task progress, or iterating through the 56-task implementation plan."
---

# Task Execution Protocol

## Overview

CloudAtlas has **56 tasks** across 7 phases in `../../docs/TASKS.md`. Detailed implementation specs are in `AGENTS.md`.

| Phase | Label | Scope |
|-------|-------|-------|
| A | `db-*` | Database schema migrations |
| B | `be-*` | Backend core services |
| C | `be-cmdb-*` | CMDB full implementation |
| D | `fe-*` | Frontend complete |
| E | `docker-*` / `ci-*` / `env-*` | DevOps & infrastructure |
| F | `be-tests-*` / `fe-tests-*` | Testing |
| G | Validation | Build, run, smoke test |

## Task Execution Loop

1. **Read current state**: check `AGENTS.md` section "What Is Already Implemented" and "Remaining Task List"
2. **Pick next task**: find the first 📋 task (respecting dependencies)
3. **Implement it completely**: code + migration + test — all steps in the task spec
4. **Verify**: run the task's acceptance criteria command
5. **Update AGENTS.md**: change `📋` to `✅` for the completed task
6. **Continue**: automatically proceed to the next task without stopping

## Dependency Order

```
Phase A (DB) → Phase B (Backend) → Phase C (CMDB) → Phase D (Frontend)
                                 ↘ Phase E (DevOps) can run in parallel with C/D
Phase B + C + D → Phase F (Tests) → Phase G (Validation)
```

Always complete all Phase A tasks before starting Phase B.

## Acceptance Criteria Commands

```bash
# After any migration
cargo sqlx migrate run --source backend/migrations

# Compile check (fast, no test execution)
cd backend && cargo check

# Full test run
cd backend && cargo test

# Docker smoke test
docker compose up --build -d
sleep 10
curl -f http://localhost:3000/api/v1/health
curl -f http://localhost:3000/api/v1/health/ready

# Frontend build check
cd frontend && npm run build
```

## Per-Task Checklist

Before marking a task ✅, verify:
- [ ] All files mentioned in the task spec are created/modified
- [ ] The task's acceptance criteria command passes
- [ ] `cargo check` passes with no warnings
- [ ] No `unwrap()` in new production paths
- [ ] New DB tables follow the migration conventions (deleted_at, created_at, UUID PK)
- [ ] New handlers have `#[utoipa::path(...)]` annotations
- [ ] New handlers call `require_permission(...)` for mutating operations

## Validation Phase (Phase G)

After all phases A–F:

1. `docker compose build` — all images build successfully
2. `docker compose up -d` — all containers start
3. Wait for health checks: `until curl -sf http://localhost:3000/api/v1/health/ready; do sleep 2; done`
4. Run smoke tests:
   ```bash
   # Register
   curl -X POST http://localhost:3000/api/v1/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"Test1234!","name":"Test User"}'

   # Login
   TOKEN=$(curl -sX POST http://localhost:3000/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"Test1234!"}' | jq -r '.access_token')

   # Create org
   ORG_ID=$(curl -s http://localhost:3000/api/v1/orgs \
     -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id')

   # List expenses
   curl -s "http://localhost:3000/api/v1/orgs/$ORG_ID/expenses/summary" \
     -H "Authorization: Bearer $TOKEN"

   # List CIs
   curl -s "http://localhost:3000/api/v1/orgs/$ORG_ID/cis" \
     -H "Authorization: Bearer $TOKEN"
   ```
5. Check Swagger UI at `http://localhost:3000/swagger-ui`
6. Produce final report: passed features, known limitations, next improvements

## Auto-Fix Protocol

If `docker compose up` fails:
1. Check container logs: `docker compose logs api`
2. Fix the root cause (migration error, missing env var, port conflict)
3. Rebuild: `docker compose up --build -d`
4. Repeat until all containers are healthy

If `cargo build` fails:
1. Read the full error
2. Fix compilation errors (type mismatch, missing imports, lifetime issues)
3. Never comment out failing code — fix it properly
4. Re-run `cargo check` before moving on
