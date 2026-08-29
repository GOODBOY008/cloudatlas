# CloudAtlas Documentation

This directory contains the documentation for CloudAtlas — a unified FinOps + CMDB platform.

## Start here

| Document | Audience | What's inside |
|----------|----------|---------------|
| [Quickstart](quickstart.md) | Everyone | From clone to running platform in ~10 min — Docker or hot-reload dev setup, login, verification, tour |
| [User Guide](user-guide.md) | Everyone | Page-by-page walkthrough of all 50+ pages: getting started, cost management, CMDB, governance, administration, troubleshooting |
| [README](../README.md) | Everyone | Project overview, feature list, quick start, architecture summary |
| [Architecture Design](design.md) | Contributors | Full technical design: data model, modules, scheduler, API layout |
| [FinOps + CMDB Intro](intro-finops-cmdb.md) | Everyone | Domain background: what FinOps and CMDB mean, and how CloudAtlas models them |

## Operations

| Document | What's inside |
|----------|---------------|
| [Production Checklist](production-checklist.md) | Hardening steps before going live |
| [Backup & Restore](backup-restore.md) | Database backup strategy and restore procedures |
| [CI/CD](ci-cd.md) | Pipeline setup and conventions |
| [API Examples](api-examples.md) | Copy-paste `curl` recipes for common workflows |

## Engineering

| Document | What's inside |
|----------|---------------|
| [ADR Index](adr/) | Architecture Decision Records — modular monolith, PostgreSQL-only, Rust/Axum, three-tier relationship pattern, sqlx-over-diesel |
| [E2E Test Plan](E2E_TEST_PLAN.md) | Playwright end-to-end test strategy |
| [Guided E2E Plan](e2e-guided-test-plan.md) | Browser-driven e2e: basic setup → CMDB → FinOps configuration — see the [2026-08-15 execution report](e2e-guided-test-report-2026-08-15.md) |
| [AI Copilot Design](ai-copilot-design.md) | Conversational cost assistant: docking panel, page context, provider config |
| [Open-Source Spec](opensource-github-spec.md) | GitHub launch plan — slogan, description, topics, social preview, settings, release strategy |

> Interactive API documentation (Swagger UI) is served by the running backend at `http://localhost:8080/swagger-ui/`.
