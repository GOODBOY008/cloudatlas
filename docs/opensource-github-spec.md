# Open-Source Launch Spec — GitHub

Everything needed to take CloudAtlas public on GitHub, in one place: identity (name, slogan, description, topics), assets (badges, social preview), repository settings, the structural fixes GitHub requires before launch, and the release/launch playbook. Items are written as **copy-paste-ready** values wherever possible.

> Status legend: ☐ todo · ☑ done in-repo. This spec is the source of truth for the launch checklist.

---

## 1. Repository Identity

| Item | Value |
|------|-------|
| Repo name | `cloudatlas` |
| Owner / URL | `https://github.com/GOODBOY008/cloudatlas` |
| Visibility | Public (flip when this checklist is complete) |
| Default branch | `main` |
| License | Apache-2.0 (☑ `cloudatlas/LICENSE` — see §6, must move to repo root) |

## 2. Slogan / Tagline

Primary (use everywhere — README hero, social preview, pitch):

> **One binary. One database. Total cloud cost & asset visibility.**

Alternates by context:

| Context | Text |
|---------|------|
| GitHub About / short (< 100 chars) | `Unified FinOps + CMDB: cloud cost optimization & infrastructure asset management in one Rust app` |
| README subtitle | `Manage cloud costs and infrastructure assets from a single pane of glass` (current, keep) |
| One-word category call | `The open-source FinOps + CMDB platform` |
| 中文（README 顶部双语行 / 发布帖） | `一体化 FinOps + CMDB 平台 —— 单一二进制、单一数据库，云成本与资产的完整可见性` |
| Tweet/X-length (≤ 280 chars) | `CloudAtlas: open-source FinOps + CMDB in one Rust binary. 25+ cost optimization modules, metadata-driven CMDB, EN/中文 UI, PostgreSQL-only — no Kafka/Redis/Elasticsearch. docker compose up and you're running. ☁️` |

## 3. GitHub "About" Section (copy-paste)

**Description** (232 of 350 chars allowed):

```
Unified FinOps + CMDB: cloud cost optimization and infrastructure asset management in one Rust app. 25+ recommendation modules, metadata-driven CMDB, multi-cloud billing (AWS/Aliyun), bilingual EN/中文. PostgreSQL-only, single binary.
```

**Website**: leave empty until a demo/GH Pages landing exists.

**Topics** (GitHub max 20, lowercase, hyphenated — paste as-is):

```
finops  cmdb  cloud-cost-management  cost-optimization  cloud-computing  multi-cloud  rust  axum  react  typescript  postgresql  asset-management  itam  devops-tools  cloud-native  infrastructure-management  cost-management  open-source  self-hosted  show-dev
```

Suggested ordering puts the two domain keywords first (`finops`, `cmdb`) — they drive discovery.

## 4. Badges

Current README badge set (☑ in place, `cloudatlas/README.md`):

| Badge | Status |
|-------|--------|
| CI (`actions/workflows/ci.yml/badge.svg`) | ⚠ renders "no status" until workflows live at repo root — see §5 |
| License Apache-2.0 | ☑ |
| Rust 1.78+ / React 18 / PostgreSQL 15+ | ☑ |
| GHCR pull (optional post-release) | ☐ add after first `v*` tag: `https://img.shields.io/badge/ghcr.io-cloudatlas-blue?logo=docker` |

Suggested badge order in README: CI · License · GHCR · Rust · React · PostgreSQL.

## 5. Pre-Launch Structural Fixes (GitHub requires repo-root paths)

GitHub only auto-detects certain files from the **repository root**, `.github/`, or `docs/` — not from the nested `cloudatlas/` app directory. Today everything sits in `cloudatlas/`, so **Actions, the community profile, and license detection are all inert**:

| What | Today | Move to | Effect once fixed |
|------|-------|---------|-------------------|
| Workflows (`ci.yml`, `e2e.yml`, `release.yml`) | `cloudatlas/.github/workflows/` | `.github/workflows/` (repo root) | Actions run; CI badge goes green; release tags build images |
| Workflow internal paths (`cd backend`, `cd frontend`, context `.`) | relative to `cloudatlas/` | prefix with `cloudatlas/` (e.g. `working-directory: cloudatlas/backend`, compose `-f cloudatlas/docker-compose.yml`) | pipelines pass from root |
| `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` | `cloudatlas/` | repo root (or root `.github/`) | Community profile banner, "Community standards" 5/5 |
| `LICENSE` | `cloudatlas/LICENSE` | repo root (keep a copy at `cloudatlas/LICENSE` if desired) | License auto-detection & sidebar |
| Issue templates + PR template | `cloudatlas/.github/ISSUE_TEMPLATE/`, `pull_request_template.md` | root `.github/` | Templates offered on new issues/PRs |

After moving: delete the copies under `cloudatlas/.github/` (keep `copilot-instructions.md`, `instructions/`, `prompts/` where they are — those are editor-facing, not GitHub-facing).

## 6. Social Preview Image

| Spec | Value |
|------|-------|
| Size | 1280 × 640 PNG (< 300 KB) |
| Background | Dark indigo→slate gradient (match README dark theme, e.g. `#0f172a → #312e81`) |
| Layout | Left: `☁️ CloudAtlas` wordmark + primary slogan (`One binary. One database. Total cloud cost & asset visibility.`) + tech chips `Rust · React · PostgreSQL` · Right: dashboard screenshot in a browser frame |
| Footer strip | `FinOps ☁ Cost Optimization ☁ CMDB` |
| Source | Generate from `docs/screenshots/dashboard-en.png`; store master at `docs/branding/social-preview.png` |
| Upload | Repo → Settings → General → Social preview (do NOT commit to repo root; upload via UI) |

## 7. Repository Settings Checklist

- [ ] Visibility: Public
- [ ] Settings → General: Features = Issues ✓, Discussions ✓ (Q&A category), Wiki ✗, Projects ✓ (optional)
- [ ] Settings → Branches: protect `main` — require PR, ≥ 1 review, require `CI` workflow pass, block force-push
- [ ] Pull requests: allow squash-merge only; default to "Commit title + pull request number"
- [ ] Actions → General → Workflow permissions: read-write (GHCR push in `release.yml` needs it) + allow GitHub Pages if used later
- [ ] Tags: enable tag protection rule `v*` (maintainers only)
- [ ] Security → Code security: dependabot ✓, secret scanning ✓, code scanning (CodeQL) ☐ optional

## 8. Release & Versioning

| Item | Value |
|------|-------|
| Scheme | SemVer `vMAJOR.MINOR.PATCH`; pre-releases `vX.Y.Z-rc.N` |
| First public release | `v0.2.0` (v0.1.0 was internal pre-oss work — or start clean at `v0.1.0`; recommend `v0.1.0`) |
| Tag → artifacts | Push tag triggers `release.yml` (☑ exists): CI gate → multi-arch Docker images to `ghcr.io/goodboy008/cloudatlas-{api,web,migrate}` |
| Release notes template | What's Changed (grouped: Features / Fixes / Docs), Docker pull commands, Quickstart link, full changelog diff link |

First release notes skeleton:

```markdown
## CloudAtlas v0.1.0 — first public release
Unified FinOps + CMDB platform: single Rust binary, PostgreSQL-only.

### Highlights
- FinOps: multi-cloud billing import (AWS/Aliyun/mock), 25+ optimization modules, pools & budgets, anomaly detection
- CMDB: metadata-driven CI model, three-tier associations, lifecycle & audit trail
- Bridge: live cost on assets, cost centers, compliance & drift
- Bilingual EN/中文 UI, dark/light, docker compose one-command start

### Run it
git clone https://github.com/GOODBOY008/cloudatlas && cd cloudatlas/cloudatlas && docker compose up
→ http://localhost:3000 · admin@acme.com / Password123!

**Full Changelog**: <diff link>
```

## 9. Launch Checklist (go-public day)

- [ ] §5 structural moves merged; CI green on the public repo
- [ ] Social preview uploaded (§6); About description + topics pasted (§3)
- [ ] `v0.1.0` tagged; images on GHCR; release notes published (§8)
- [ ] README hero sanity-check on GitHub rendering (badges, screenshots, anchors)
- [ ] Submit: `awesome-finops`, `awesome-rust` (PR), `r/selfhosted`, `r/FinOps`, HN Show HN (use §10 pitch), V2EX (中文), TODO groups
- [ ] Pin an issue: "Welcome + roadmap"; enable Discussions intro post
- [ ] Star CTA remains at README footer (☑)

## 10. Elevator Pitches

**One-liner.** "CloudAtlas fuses cloud cost optimization (FinOps) and infrastructure asset management (CMDB) into one open-source Rust app — one binary, one PostgreSQL database."

**Paragraph (README/blog).** "CloudAtlas is an open-source platform that unifies FinOps cost management and CMDB asset tracking in a single Rust/Axum binary backed only by PostgreSQL — no Kafka, Redis, or Elasticsearch. Cloud billing from AWS, Alibaba Cloud, or the built-in mock provider flows into two-tier expenses, pools, budgets, and 25+ optimization modules; the same discovery feeds a metadata-driven CMDB with three-tier associations, lifecycle, drift, and compliance — and every asset carries its live cost. Bilingual EN/中文 UI, one-command Docker start."

**Show HN draft.** `Show HN: CloudAtlas — open-source FinOps + CMDB in one Rust binary` — body: the paragraph above + "Why: existing open-source FinOps and CMDB tools are each 15+ microservices. We rebuilt that intent as one Axum monolith + PostgreSQL-only, with the FinOps↔CMDB bridge (live cost on every asset) as the differentiator. docker compose up, seeded demo org, bilingual UI. Apache-2.0. Looking for feedback on the recommendation-module API and which clouds to add next (GCP? Azure?)."

**SEO keywords.** finops open source, cloud cost optimization self-hosted, cmdb open source, cloud asset management, aws cost optimization tool, alibaba cloud billing, rust axum dashboard, itam, showback chargeback.

---

*Maintenance: update this spec whenever identity, topics, or release process changes; it is linked from `docs/README.md`.*
