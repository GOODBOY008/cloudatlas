# Open-Source Launch Spec — GitHub

Everything needed to take CloudAtlas public on GitHub, in one place: identity (name, slogan, description, topics), assets (badges, social preview), repository settings, the in-repo readiness state, and the release/launch playbook. Items are written as **copy-paste-ready** values wherever possible.

> Status legend: ☐ todo · ☑ done/verified in-repo. This spec is the source of truth for the launch checklist. Last audit: **2026-09-20**.

---

## 1. Repository Identity

| Item | Value | Status |
|------|-------|--------|
| Repo name | `cloudatlas` | |
| Owner / URL | `https://github.com/GOODBOY008/cloudatlas` | ☐ repo not created yet (no git remote) |
| Visibility | Public (flip when §5 remaining items are done) | ☐ |
| Default branch | `main` | ☑ |
| Repo layout | **Repository root = project root** (no nested `cloudatlas/` directory) — workflows, templates, and community files are all GitHub-detectable | ☑ verified |
| License | Apache-2.0 at repo root | ☑ |

## 2. Slogan / Tagline

Primary (use everywhere — README hero ☑, social preview, pitch):

> **One binary. One database. Total cloud cost & asset visibility.**

Alternates by context:

| Context | Text |
|---------|------|
| GitHub About / short (< 100 chars) | `Unified FinOps + CMDB: cloud cost optimization & infrastructure asset management in one Rust app` |
| README subtitle | `Manage cloud costs and infrastructure assets from a single pane of glass` (kept under the slogan) |
| One-word category call | `The open-source FinOps + CMDB platform` |
| 中文（README 双语行 / 发布帖） | `一体化 FinOps + CMDB 平台 —— 单一二进制、单一数据库，云成本与资产的完整可见性` |
| Tweet/X-length (≤ 280 chars) | `CloudAtlas: open-source FinOps + CMDB in one Rust binary. 25+ cost optimization modules, metadata-driven CMDB, K8s rightsizing, EN/中文 UI, PostgreSQL-only — no Kafka/Redis/Elasticsearch. docker compose up and you're running. ☁️` |

## 3. GitHub "About" Section (copy-paste)

**Description** (282 of 350 chars allowed):

```
Unified FinOps + CMDB: cloud cost optimization and infrastructure asset management in one Rust app. 25+ recommendation modules, metadata-driven CMDB, multi-cloud billing (AWS/Aliyun), Kubernetes rightsizing, bilingual EN/中文 UI. PostgreSQL-only, single binary, docker compose up.
```

**Website**: leave empty until a demo/GH Pages landing exists.

**Topics** (GitHub max 20, lowercase, hyphenated — paste as-is; first two drive discovery):

```
finops  cmdb  cloud-cost-management  cost-optimization  multi-cloud  aws  alibaba-cloud  kubernetes  rust  axum  react  typescript  postgresql  docker  self-hosted  asset-management  itam  devops-tools  cloud-native  infrastructure-management
```

Topic rationale (2026-09-20 revision):

| Change | Reason |
|--------|--------|
| ➕ `kubernetes` | K8s rightsizing module + included Helm chart — real capability, high-traffic topic |
| ➕ `docker` | Compose-first deployment is a headline feature |
| ➕ `aws`, `alibaba-cloud` | Both are billing sources; high-traffic topics, and Aliyun support is a differentiator niche (few OSS FinOps tools have it) |
| ➖ `cloud-computing` | Too vague to drive discovery |
| ➖ `cost-management` | Duplicate of `cloud-cost-management` |
| ➖ `open-source` | Redundant — every repo is; wasted slot |
| ➖ `show-dev` | Reddit concept, not a GitHub discovery topic |

**Apply everything in one shot** (from the repo root; requires `gh` authenticated as GOODBOY008):

```bash
# 1. Create the public repo and push main
gh repo create cloudatlas --public \
  --description "Unified FinOps + CMDB: cloud cost optimization and infrastructure asset management in one Rust app. 25+ recommendation modules, metadata-driven CMDB, multi-cloud billing (AWS/Aliyun), Kubernetes rightsizing, bilingual EN/中文 UI. PostgreSQL-only, single binary, docker compose up." \
  --source . --remote origin --push

# 2. Topics (repeat --add-topic per topic)
gh repo edit --add-topic finops --add-topic cmdb --add-topic cloud-cost-management \
  --add-topic cost-optimization --add-topic multi-cloud --add-topic aws \
  --add-topic alibaba-cloud --add-topic kubernetes --add-topic rust --add-topic axum \
  --add-topic react --add-topic typescript --add-topic postgresql --add-topic docker \
  --add-topic self-hosted --add-topic asset-management --add-topic itam \
  --add-topic devops-tools --add-topic cloud-native --add-topic infrastructure-management

# 3. Branch protection (public repos: free) — heredoc keeps types exact.
#    Contexts = the display names of the 4 CI jobs in ci.yml.
gh api -X PUT repos/GOODBOY008/cloudatlas/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "Backend (Rust)" },
      { "context": "Frontend (TypeScript/React)" },
      { "context": "Docker Build" },
      { "context": "Smoke Tests (Docker Compose)" }
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
# If GitHub reports an unknown context, copy the exact check name from the PR's checks panel.
```

> `gh repo create --source . --push` pushes **committed** state only — commit or stash local changes first.

## 4. Badges

Current README badge set (☑ in place, `README.md`):

| Badge | Status |
|-------|--------|
| CI (`actions/workflows/ci.yml/badge.svg`) | ⚠ shows "no status" only until the repo exists and CI runs once — expected |
| License Apache-2.0 | ☑ |
| Rust 1.78+ / React 18 / PostgreSQL 15+ | ☑ |
| GHCR pull | ☐ add after first `v*` tag: `https://img.shields.io/badge/ghcr.io-cloudatlas-blue?logo=docker` linking to `https://github.com/GOODBOY008/cloudatlas/pkgs/container/cloudatlas-api` |

Suggested badge order in README: CI · License · GHCR · Rust · React · PostgreSQL.

## 5. In-Repo Readiness (audit 2026-09-20)

The original blocker — everything nested in a `cloudatlas/` app directory — is resolved: **the repository root is the project root**. Verified state:

| What | Status |
|------|--------|
| Workflows `ci.yml`, `e2e.yml`, `release.yml` at `.github/workflows/` with repo-root-relative `working-directory:` paths | ☑ verified |
| `LICENSE` (Apache-2.0), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` at repo root | ☑ |
| `SECURITY.md` at repo root | ☑ created 2026-09-20 |
| Issue templates (`.github/ISSUE_TEMPLATE/*.yml` + config) and PR template | ☑ |
| `.env` ignored by git; only `.env.example` tracked (verified `git ls-files`) | ☑ |
| Helm chart at `deploy/cloudatlas/` (v0.1.0 — backend/frontend/migrate/ingress/postgres) | ☑ |
| Screenshots for README hero grid in `docs/screenshots/` (8 pages EN + 1 ZH) | ☑ |
| Seed demo data (Acme Corp, admin/alice/bob) consolidated into baseline `001_init.sql` — no separate seed migration to reference | ☑ |
| README accuracy pass (slogan hero, "Why CloudAtlas?" section, K8s feature row, Helm install, 50+ pages, 9 test suites, security section) | ☑ 2026-09-20 |

Remaining pre-launch gaps:

- [ ] **GitHub repo does not exist yet** — no git remote configured; create via §3 apply block
- [ ] Social preview image (§6) — generate + upload
- [ ] Repo settings toggles (§7) — Discussions, tag protection `v*`, private vulnerability reporting
- [ ] First `v0.1.0` tag → release workflow → GHCR images (§8)
- [ ] Optional: `CHANGELOG.md` — first release notes can live on the GitHub Release object; add a changelog file once there is more than one release
- [ ] Optional polish: Helm `values.yaml` carries `redisUrl` / `sentryDsn` placeholder keys that the PostgreSQL-only architecture never uses — either wire them to real (optional) integrations or drop them to keep the "no Redis" story clean

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

- [ ] Visibility: Public (via §3 create command)
- [ ] Settings → General: Features = Issues ✓, Discussions ✓ (Q&A category), Wiki ✗, Projects ✓ (optional)
- [ ] Settings → Branches: protect `main` (via §3 gh api command) — require PR, ≥ 1 review, CI pass, block force-push
- [ ] Pull requests: allow squash-merge only; default to "Commit title + pull request number"
- [ ] Actions → General → Workflow permissions: **read-write** (GHCR push in `release.yml` needs it)
- [ ] Tags: enable tag protection rule `v*` (maintainers only)
- [ ] Security → Code security: **Private vulnerability reporting ✓** (referenced by `SECURITY.md`), Dependabot ✓, secret scanning ✓, code scanning (CodeQL) ☐ optional

## 8. Release & Versioning

| Item | Value |
|------|-------|
| Scheme | SemVer `vMAJOR.MINOR.PATCH`; pre-releases `vX.Y.Z-rc.N` |
| First public release | `v0.1.0` (clean start; no earlier tags exist) |
| Tag → artifacts | Push tag triggers `release.yml` ☑: multi-arch Docker images to `ghcr.io/goodboy008/cloudatlas-api`, `cloudatlas-frontend`, `cloudatlas-migrate` |
| Helm | Chart version tracks app version in `deploy/cloudatlas/Chart.yaml` |
| Release notes template | What's Changed (grouped: Features / Fixes / Docs), Docker pull commands, Helm install, Quickstart link, full changelog diff link |

First release notes skeleton:

```markdown
## CloudAtlas v0.1.0 — first public release

Unified FinOps + CMDB platform: single Rust binary, PostgreSQL-only.

### Highlights
- FinOps: multi-cloud billing import (AWS/Aliyun/mock), 25+ optimization modules, pools & budgets, anomaly detection, BI export
- CMDB: metadata-driven CI model, three-tier associations, lifecycle, audit trail, drift & compliance
- Bridge: live cost on every asset — cost centers, showback/chargeback
- Kubernetes: container rightsizing + K8s objects as CIs; Helm chart included
- Bilingual EN/中文 UI, dark/light, one-command Docker start

### Run it
git clone https://github.com/GOODBOY008/cloudatlas.git && cd cloudatlas && docker compose up
→ http://localhost:3000 · admin@acme.com / Password123!

### Kubernetes
helm install cloudatlas ./deploy/cloudatlas --set backend.jwtSecret=... --set backend.encryptionKey=...

**Full Changelog**: <diff link>
```

## 9. Launch Checklist (go-public day)

- [ ] Commit local changes; run §3 apply block (create repo, topics, branch protection)
- [ ] CI green on the public repo; CI badge renders
- [ ] Social preview uploaded (§6); About description + topics verified on the repo page (§3)
- [ ] `v0.1.0` tagged; images on GHCR; release notes published (§8)
- [ ] README hero sanity-check on GitHub rendering (badges, screenshots, anchors, Helm section)
- [ ] Submit: `awesome-finops`, `awesome-rust` (PR), `r/selfhosted`, `r/FinOps`, HN Show HN (use §10 pitch), V2EX (中文), TODO groups
- [ ] Pin an issue: "Welcome + roadmap"; enable Discussions intro post
- [ ] Star CTA remains at README footer (☑)

## 10. Elevator Pitches

**One-liner.** "CloudAtlas fuses cloud cost optimization (FinOps) and infrastructure asset management (CMDB) into one open-source Rust app — one binary, one PostgreSQL database."

**Paragraph (README/blog).** "CloudAtlas is an open-source platform that unifies FinOps cost management and CMDB asset tracking in a single Rust/Axum binary backed only by PostgreSQL — no Kafka, Redis, or Elasticsearch. Cloud billing from AWS, Alibaba Cloud, or the built-in mock provider flows into two-tier expenses, pools, budgets, and 25+ optimization modules; the same discovery feeds a metadata-driven CMDB with three-tier associations, lifecycle, drift, and compliance — and every asset carries its live cost. Kubernetes rightsizing, BI exports, and a bilingual EN/中文 UI round it out. One command to start."

**Show HN draft.** `Show HN: CloudAtlas — open-source FinOps + CMDB in one Rust binary` — body: the paragraph above + "Why: existing open-source FinOps and CMDB tools are each 15+ microservices. We rebuilt that intent as one Axum monolith + PostgreSQL-only, with the FinOps↔CMDB bridge (live cost on every asset) as the differentiator. docker compose up, seeded demo org, bilingual UI. Apache-2.0. Looking for feedback on the recommendation-module API and which clouds to add next (GCP? Azure?)."

**SEO keywords.** finops open source, cloud cost optimization self-hosted, cmdb open source, cloud asset management, aws cost optimization tool, alibaba cloud billing, kubernetes cost optimization, rust axum dashboard, itam, showback chargeback.

---

*Maintenance: update this spec whenever identity, topics, or release process changes; it is linked from `docs/README.md`.*
