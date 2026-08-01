# CloudAtlas User Guide

> **CloudAtlas** — Unified FinOps + CMDB Platform  
> Version 2.1 · August 2026

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
   - [System Requirements](#21-system-requirements)
   - [Quick Start (Docker)](#22-quick-start-docker)
   - [First Login](#23-first-login)
3. [Core Concepts](#3-core-concepts)
4. [Organization & User Management](#4-organization--user-management)
   - [Roles & Permissions](#41-roles--permissions)
   - [Inviting Members](#42-inviting-members)
5. [Cloud Accounts](#5-cloud-accounts)
6. [Overview](#6-overview)
   - [Dashboard](#61-dashboard)
   - [Recommendations](#62-recommendations)
   - [Checklist](#63-checklist)
   - [AI Center](#64-ai-center)
7. [Cost Management](#7-cost-management)
   - [Cost Explorer](#71-cost-explorer)
   - [Cost Map](#72-cost-map)
   - [Showback](#73-showback)
   - [Budgets & Quotas](#74-budgets--quotas)
   - [Cost Comparison](#75-cost-comparison)
   - [S3 Duplicates](#76-s3-duplicates)
   - [BI Export](#77-bi-export)
8. [Resource Management](#8-resource-management)
   - [Resources](#81-resources)
   - [Pools](#82-pools)
   - [Shared Environments](#83-shared-environments)
   - [Resource Lifecycle](#84-resource-lifecycle)
   - [K8s Rightsizing](#85-k8s-rightsizing)
   - [Archive](#86-archive)
9. [Asset Inventory](#9-asset-inventory)
   - [Configuration Items](#91-configuration-items)
   - [Services](#92-services)
   - [Dynamic Groups](#93-dynamic-groups)
   - [Classifications](#94-classifications)
   - [Associations](#95-associations)
   - [Model Topology](#96-model-topology)
   - [Service Templates](#97-service-templates)
   - [CI Import](#98-ci-import)
   - [Inventory Stats](#99-inventory-stats)
   - [CMDB Audit Log](#910-cmdb-audit-log)
   - [External CMDB](#911-external-cmdb)
10. [Governance](#10-governance)
    - [Compliance](#101-compliance)
    - [Tagging Coverage](#102-tagging-coverage)
    - [Tagging Policies](#103-tagging-policies)
    - [Constraints](#104-constraints)
    - [Drift Detection](#105-drift-detection)
    - [Anomaly Detection](#106-anomaly-detection)
    - [Power Schedules](#107-power-schedules)
    - [Apply Rules](#108-apply-rules)
11. [Administration](#11-administration)
    - [Cloud Accounts](#111-cloud-accounts)
    - [Billing Import](#112-billing-import)
    - [Cost Centers](#113-cost-centers)
    - [Alerts](#114-alerts)
    - [Alert Events](#115-alert-events)
    - [Events](#116-events)
    - [Webhooks](#117-webhooks)
    - [Integrations](#118-integrations)
    - [Assignment Rules](#119-assignment-rules)
    - [Settings](#1110-settings)
12. [Language & Theme](#12-language--theme)
13. [API Reference](#13-api-reference)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Introduction

CloudAtlas is an open-source, self-hosted platform that unifies **FinOps cost management** with **CMDB asset tracking** in a single application. It is designed for engineering and finance teams that need a single source of truth for both cloud spending and infrastructure topology.

### Key capabilities

| Area | What CloudAtlas provides |
|---|---|
| **FinOps** | Multi-cloud billing ingestion (AWS, Alibaba), hierarchical cost pools, budget alerts, anomaly detection, 25+ optimization recommendation modules, cost comparison, S3 duplicate detection, showback/chargeback, BI exports |
| **CMDB** | Metadata-driven CI registry, three-tier relationship system, lifecycle tracking, compliance drift detection, topology visualization, service templates, bulk import, external CMDB connections |
| **AI** | Chat assistant grounded in your data, spend forecasting, anomaly explanations, RAG knowledge base with semantic search |
| **Governance** | RBAC with five built-in roles, tagging policies, spending constraints, drift detection, assignment rules, resource lifecycle automation, K8s rightsizing |
| **Automation** | Background cloud sync, power schedules, webhook event delivery, integrations (Slack, ...), CI auto-patching rules |
| **Simplicity** | Single PostgreSQL database, Docker-first deployment, fully bilingual UI (English / 中文), no Redis/Kafka/Elasticsearch required |

### Navigation

The CloudAtlas sidebar is organized into six groups:

| Group | Pages |
|---|---|
| **Overview** | Dashboard, Recommendations, Checklist, AI Center |
| **Cost Management** | Cost Explorer, Cost Map, Showback, Budgets & Quotas, Cost Comparison, S3 Duplicates, BI Export |
| **Resource Management** | Resources, Pools, Shared Environments, Resource Lifecycle, K8s Rightsizing, Archive |
| **Asset Inventory** | Configuration Items, Services, Dynamic Groups, CI Types, Classifications, Associations, Model Topology, Service Templates, CI Import, Inventory Stats, External CMDB |
| **Governance** | Compliance, Tagging Coverage, Tagging Policies, Constraints, Drift Detection, Anomaly Detection, Power Schedules, Apply Rules |
| **Administration** | Cloud Accounts, Billing Import, Cost Centers, Alerts, Alert Events, Events, Webhooks, Integrations, Rules, Settings |

A dark/light theme toggle and an EN / 中文 language switch are available in the top-right corner of the header. Your preferences are saved automatically. The header also has a **Global Search** box and a labeled **Copilot** button (shortcut: ⌘/Ctrl+I) that opens the Copilot side panel.

---

## 2. Getting Started

### 2.1 System Requirements

| Component | Minimum |
|---|---|
| Docker | 24+ |
| Docker Compose | v2 plugin |
| RAM | 2 GB (4 GB recommended) |
| Disk | 10 GB |
| Ports | 3000 (frontend), 8080 (API) |

### 2.2 Quick Start (Docker)

```bash
# 1. Clone the repository
git clone <repo-url>
cd cloudatlas

# 2. Configure environment
cp .env.example .env
# Edit .env — change JWT_SECRET and ENCRYPTION_KEY at minimum

# 3. Start all services (PostgreSQL + migrations + API + frontend)
docker compose up

# 4. Open the platform
#   Frontend:   http://localhost:3000
#   API:        http://localhost:8080/api/v1
#   Swagger UI: http://localhost:8080/swagger-ui/
```

> **Development mode** (hot-reload):
> ```bash
> docker compose -f docker-compose.dev.yml up
> # or:
> make dev
> ```

### 2.3 First Login

The seed data creates a demo organization **Acme Corp** with three pre-configured accounts:

| Email | Password | Notes |
|---|---|---|
| `admin@acme.com` | `Password123!` | Admin User — org owner |
| `alice@acme.com` | `Password123!` | Alice Chen — member |
| `bob@acme.com` | `Password123!` | Bob Smith — member |

The seed also includes two mock cloud accounts with discovered resources, 30+ days of expenses, 13 cost pools, and recommendations — so every page has data to explore without connecting a real cloud.

After logging in you will land on the **Dashboard**, which shows:

- Total cloud spend this month vs last month
- 30-day cost trend chart with forecast
- Active recommendations count
- Top 5 spending resources
- Budget utilization across pools
- Anomaly alerts

---

## 3. Core Concepts

Understanding these building blocks will help you navigate CloudAtlas effectively.

```
Organization
  ├── Members (with Roles)
  ├── Cloud Accounts  ──► Sync Resources ──► CMDB CIs
  ├── Cost Pools      ◄── Expenses (daily aggregated)
  ├── Recommendations ◄── Optimization engine
  ├── Budgets         ──► Alerts
  ├── Cost Centers    ──► Business unit allocation
  ├── Power Schedules ──► Auto start/stop
  ├── Shared Environments ──► Booking system
  ├── Lifecycle Policies ──► TTL / idle shutdown
  └── Webhooks        ──► External notifications
```

| Concept | Description |
|---|---|
| **Organization** | Top-level tenant. All data is scoped to an organization. |
| **Cloud Account** | Credentials for a cloud provider (AWS, Alibaba, Mock). Resources are discovered and billing is imported from each account. |
| **CI (Configuration Item)** | Any trackable asset — a VM, database, load balancer, Kubernetes cluster, etc. CIs live in the CMDB. |
| **Expense** | A daily aggregated cost record for a cloud resource, linked to the cloud account and optionally to a CI. |
| **Pool** | A hierarchical cost bucket used to allocate and track spending by team, project, or environment. |
| **Recommendation** | An actionable cost-optimization finding (e.g., "idle instance — save $40/month"). |
| **Budget** | A spending limit on a pool with configurable alert thresholds. |
| **Cost Center** | A business unit in a hierarchical cost allocation tree. |
| **Power Schedule** | A rule that automatically starts or stops a resource group outside business hours. |
| **Shared Environment** | A bookable cloud environment with conflict prevention. |
| **Lifecycle Policy** | Automated TTL or idle-shutdown rule for cloud resources. |

---

## 4. Organization & User Management

### 4.1 Roles & Permissions

CloudAtlas uses a five-role RBAC model scoped to each organization.

| Role | Description |
|---|---|
| **Owner** | Full access. Can manage members, billing, CMDB, and platform settings. |
| **Admin** | Like Owner but cannot delete the organization or transfer ownership. |
| **FinOps** | View and manage expenses, pools, budgets, recommendations, and assignment rules. Cannot edit CMDB models. |
| **CMDB Editor** | Create and edit CI types, CI instances, associations, services, and compliance policies. Cannot manage billing. |
| **Viewer** | Read-only access to all data. |

**Permission matrix summary:**

| Action | Owner | Admin | FinOps | CMDB Editor | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| Manage organization settings | ✅ | ✅ | ❌ | ❌ | ❌ |
| Invite / remove members | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage cloud accounts | ✅ | ✅ | ✅ | ❌ | ❌ |
| Manage pools & budgets | ✅ | ✅ | ✅ | ❌ | ❌ |
| View expenses & recommendations | ✅ | ✅ | ✅ | ✅ | ✅ |
| Manage CI types & instances | ✅ | ✅ | ❌ | ✅ | ❌ |
| Manage compliance policies | ✅ | ✅ | ❌ | ✅ | ❌ |
| View all data | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.2 Inviting Members

1. Go to **Settings → Members**.
2. Click **Invite Member**.
3. Enter the email address and choose a role.
4. The invitee receives an email with a link to join the organization.

> Only **Owner** and **Admin** roles can invite new members.

---

## 5. Cloud Accounts

Cloud accounts are the source of both resource discovery (CMDB) and billing data (FinOps). CloudAtlas supports **AWS**, **Alibaba Cloud**, and a **Mock** provider for testing. See [Section 11.1](#111-cloud-accounts) for the full administration guide.

---

## 6. Overview

### 6.1 Dashboard

The **Dashboard** is your central command center, aggregating key FinOps and CMDB metrics at a glance.

**Summary cards** (clickable — navigate to detail pages):

| Card | Shows |
|---|---|
| **Total Cost MTD** | Month-to-date cloud spend with month-over-month delta |
| **Resources** | Total tracked cloud resources count |
| **Active Recommendations** | Open optimization findings |
| **Pools** | Number of cost pools |

**Charts and panels:**

- **30-Day Cost Trend** — area chart showing daily spend over the last 30 days
- **30-Day Forecast** — projected monthly spend with trend percentage
- **Anomaly Alerts** — card highlighting detected cost anomalies
- **Top 5 Resources** — highest-spending resources this month
- **Pools Needing Attention** — pools exceeding 80% of their budget

### 6.2 Recommendations

CloudAtlas automatically analyzes your cloud resources and generates actionable cost-optimization recommendations.

#### Recommendation Types

**Idle / Abandoned resources**

| Type | Description | Typical savings |
|---|---|---|
| Abandoned instance | VM with < 5% CPU and < 10 MB/s network for 7+ days | Stop or terminate |
| Volumes not attached | EBS/disk volumes not mounted to any instance | Delete or snapshot |
| Obsolete IPs | Static/elastic IPs not attached to a resource | Release |
| Abandoned load balancer | LB with no healthy targets for 7+ days | Delete |
| Abandoned S3 buckets | Buckets with no GET/PUT activity in 30+ days | Lifecycle policy or delete |
| Instances for shutdown | Non-production instances running after business hours | Use power schedules |

**Rightsizing**

| Type | Description |
|---|---|
| Instance rightsizing | Downsize overprovisioned VMs based on actual CPU/memory utilization |
| RDS rightsizing | Downsize overprovisioned database instances |
| Instance generation upgrade | Move to newer, more cost-efficient instance family |

**Storage optimization**

| Type | Description |
|---|---|
| Obsolete snapshots | Snapshots older than 30 days with no associated AMI |
| Obsolete snapshot chains | Chains of incremental snapshots that can be consolidated |
| S3 Intelligent-Tiering | Move infrequently accessed S3 objects to cheaper storage class |

**Security**

| Type | Description |
|---|---|
| Insecure security groups | Security groups with `0.0.0.0/0` ingress on sensitive ports |
| S3 public buckets | Buckets with public read or write ACL |
| Inactive IAM users | IAM users with no activity in 90+ days |

#### Acting on Recommendations

1. Go to **Recommendations** in the sidebar.
2. Filter by type, status, or estimated savings.
3. Click a recommendation to see:
   - Resource details and usage metrics
   - Estimated monthly savings
   - Recommended action with step-by-step instructions
4. Choose an action:
   - **Apply** — Mark as applied (CloudAtlas does not modify cloud resources directly; you apply changes in your cloud console)
   - **Dismiss** — Dismiss with a reason (e.g., "intentionally over-provisioned for peak traffic")
   - **Snooze** — Defer for N days

**Recommendation states:**

```
active → dismissed
active → applied
active → snoozed → active (after snooze expires)
applied → archived
dismissed → archived
```

#### Archived Recommendations

Recommendations that have been applied or dismissed are moved to the **Archive**. To review them:

1. Go to **Archive** in the sidebar.
2. Filter by type, date, or action taken.
3. Click **Restore** to move a recommendation back to active status if the issue recurs.

### 6.3 Checklist

The **Checklist** page is mission control for the recommendation engine itself — it shows which of the 25+ detection modules are enabled and lets you tune the engine to your environment.

**Summary cards:**

| Card | Shows |
|---|---|
| **Adoption Score** | Percentage of engine modules currently enabled |
| **Active Recommendations** | Open findings across all modules |
| **Dismissed Recommendations** | Findings you have dismissed |
| **Last Engine Run** | Timestamp and status (completed / running / failed / idle) of the latest run |

**Using the checklist:**

1. Browse the module table — each row shows the module key (e.g., `abandoned_volume`, `rightsizing_instance`, `insecure_security_group`), its threshold in days, and the engine state.
2. Toggle a module **on/off** to control whether that detection runs in future engine passes.
3. If the last run failed, the error banner shows the reason.

This is the right page to visit when the engine produces noisy findings you don't care about — disable the module rather than dismissing findings one by one.

### 6.4 AI Center

The **AI Center** centralizes CloudAtlas's optional AI features. AI features need a provider configured either per-organization in **Settings → AI Provider** (base URL, API key, models — no restart needed) or via the backend environment (`AI_ENABLED=true` + `OPENAI_API_KEY`); without either, the assistant falls back to deterministic local mode.

**Tabs:**

| Tab | Purpose |
|---|---|
| **Assistant** | Shortcut to the global Copilot chat panel (grounded in your cost and inventory data) |
| **Forecast** | AI-assisted spend forecast — historical 90-day total and projected next-14-day spend |
| **Anomalies** | Detected anomalies with direction (spike/dip), value, and z-score |
| **Notes** | Knowledge base: create notes, then search them **semantically** (embedding-based) or by keyword, with match scores |
| **Settings** | Toggle individual features: assistant, smart recommendations, forecast, anomaly detection, RAG |

> AI features are optional. The platform is fully functional without them, and your data is only sent to the LLM provider when a feature is explicitly enabled and used.

---

## 7. Cost Management

### 7.1 Cost Explorer

The **Cost Explorer** (sidebar: "Cost Explorer") is the primary tool for analyzing cloud spending across multiple dimensions.

**Analysis tabs:**

| Tab | What it shows |
|---|---|
| **Overview** | MTD total, daily trend chart, top resources, spend by cloud |
| **By Service** | Breakdown by cloud service (EC2, RDS, S3, etc.) |
| **By Region** | Spend grouped by cloud region |
| **By Cloud** | Spend per cloud provider (AWS, Alibaba, etc.) |
| **By Pool** | Cost allocation across cost pools |
| **Trend** | Daily cost time-series with moving averages |
| **Top Resources** | Highest-spending individual resources |
| **Forecast** | Projected monthly spend based on current trajectory |
| **Anomalies** | Detected cost spikes with deviation scores |
| **RI Coverage** | Reserved Instance utilization and coverage gaps |
| **By Tag** | Spend grouped by tag key-value pairs |

**Using filters:**

1. Use the date range picker to select a time period.
2. Filter by cloud account, resource type, region, or tag.
3. Click a resource row to open the **Resource History Panel**, which shows:
   - Daily cost sparkline over time
   - Period-over-period comparison cards
   - Resource tags and metadata

### 7.2 Cost Map

The **Cost Map** provides four visual views of your cloud spend:

| Tab | What it shows |
|---|---|
| **World Map** | Geographic distribution of spending; bubbles sized by cost across AWS/Azure/GCP regions with provider color coding; hover tooltips; provider bar chart; region breakdown table |
| **Treemap** | Hierarchical spending breakdown by any dimension (cloud, service, region, pool, resource type); drill-down with breadcrumb navigation; clickable top-nodes table |
| **Unit Economics** | Per-resource-type metrics: count, total cost, daily average, cost per resource, % of total; bar chart and table |
| **Budget Matrix** | All pools with MTD actual vs. budget; utilization bar; status badges (on track, warning, over budget, no budget) |

**Using the Treemap:**

1. Select a **primary dimension** (e.g., `service`) from the dropdown.
2. Optionally select a **secondary dimension** for nested breakdown.
3. Click a node in the treemap or the top-nodes table to drill down.
4. Use the breadcrumb to navigate back up.

### 7.3 Showback

The **Showback** page generates allocation reports that attribute costs to internal teams for cross-charge reporting.

1. Go to **Showback** in the sidebar.
2. The report breaks down the last 30 days of spend by:
   - **Pool allocation** — each pool's share of total spend
   - **Cost center allocation** — via business capabilities → services → CIs → expenses join
3. View `allocation_pct` per bucket and unallocated cost summary.
4. Export to CSV to share with finance.

### 7.4 Budgets & Quotas

The **Budgets & Quotas** page consolidates pool budgets, alert rules, and spending quotas in one place.

**Summary cards:**

| Card | Shows |
|---|---|
| **Total Budget** | Sum of all pool budgets |
| **Total Spend** | Current MTD spend across all pools |
| **Over Budget** | Number of pools exceeding their budget |
| **Warning** | Number of pools approaching their budget limit |

**Tabs:**

| Tab | Purpose |
|---|---|
| **Pool Budgets** | Budget vs. actual with progress bars for each pool; click to see details |
| **Alert Rules** | Create and manage budget alert rules with configurable thresholds (e.g., alert at 80%, 100%) |
| **Quotas** | Create and manage organization-level spending constraints (total expense limits, resource count limits) |

**Creating a budget alert rule:**

1. Go to the **Alert Rules** tab.
2. Click **Create Alert Rule**.
3. Select a pool and set threshold percentage.
4. Choose notification channel (email, webhook, or both).
5. Save.

**Evaluating alerts:**

Click **Evaluate Now** to trigger on-demand evaluation of all alert rules. Alert events are created when thresholds are crossed.

### 7.5 Cost Comparison

The **Cost Comparison** page lets you compare spending between two time periods.

**How to use:**

1. Select **Period A** date range (e.g., last month).
2. Select **Period B** date range (e.g., this month).
3. Choose a **Group By** dimension: service, region, cloud provider, or pool.
4. Review the results:
   - **Summary cards** — Period A total, Period B total, dollar and percentage change
   - **Side-by-side bar chart** — visual comparison per group
   - **Comparison table** — detailed breakdown with dollar delta and percentage delta per group
   - Items with >50% change are flagged with an alert indicator

### 7.6 S3 Duplicates

The **S3 Duplicates** page finds similar or duplicated S3 buckets across your accounts — a common source of silent storage waste after team migrations and experiment leftovers.

**Summary cards:**

| Card | Shows |
|---|---|
| **Buckets** | Total object-storage buckets scanned |
| **Similar Pairs** | Bucket pairs above the similarity threshold |
| **Duplicate Groups** | Groups of 3+ mutually-similar buckets |
| **Potential Savings** | Estimated monthly saving from consolidating duplicates |

**Tabs:**

| Tab | What it shows |
|---|---|
| **Groups** | Duplicate-group cards, each listing member buckets with region, object count, and monthly cost, plus the redundant count and cost |
| **Matrix** | Pairwise similarity scores sorted descending — red ≥ 80%, yellow ≥ 50%, green below |
| **Buckets** | Flat list of all scanned buckets |

Click **Scan Now** to re-run the duplicate analysis after new billing data lands.

### 7.7 BI Export

**BI Export** produces recurring CSV/JSON extracts of your CloudAtlas data for external BI tools (Tableau, Power BI, Metabase, or plain spreadsheets).

**Creating an export:**

1. Click **Create Export**.
2. Configure:
   - **Name** — e.g., `Monthly expenses → finance BI`
   - **Format** — CSV or JSON
   - **Scope** — `expenses`, `resources`, or `recommendations`
   - **Date range** — start/end dates (shown for the expenses scope)
3. Save.

**Running and downloading:**

1. Click **Run** on an export card to generate a fresh file.
2. Click **Download** to save it locally.
3. Expand the card to see the run history: status, row count, error message, and timestamp per run.

Exports are read-only snapshots — they never modify platform data.

---

## 8. Resource Management

### 8.1 Resources

The **Resources** page provides a unified view of all tracked cloud resources across all accounts.

**Browsing resources:**

1. Go to **Resources** in the sidebar.
2. Use the **search bar** to find resources by name or ID.
3. Filter by **resource type** (instance, volume, bucket, etc.) and **active/inactive** status.
4. The paginated table shows: Name/ID, Type, Region, Service, Pool, Total Cost, Last Month spend, and Status.

**Resource detail panel:**

Click any resource row to open the slide-out detail panel, which shows:

- **KPI cards** — total cost, last month spend, resource count metrics
- **Daily cost sparkline** — cost trend over time
- **Recommendations** — any open optimization findings for this resource
- **Tags** — editable tag list; click to add, edit, or remove tags inline

### 8.2 Pools

Pools are hierarchical cost buckets that let you allocate cloud spend to teams, projects, environments, or any logical grouping.

**Creating a pool:**

1. Go to **Pools** in the sidebar.
2. Click **Create Pool**.
3. Fill in:
   - **Name**: e.g., `Engineering / Backend`
   - **Parent**: Nest under an existing pool (optional)
   - **Owner**: Member responsible for this pool's budget
   - **Type**: Pool classification (optional)
4. Save.

**Pool tree example:**
```
Acme Corp (root)
├── Engineering
│   ├── Backend Team    ← $8,200/mo
│   └── Frontend Team   ← $3,100/mo
├── Data Platform       ← $6,500/mo
└── Shared Services     ← $2,200/mo
```

**Pool detail panel:**

Click a pool to open the detail panel with:

- **Expense trend chart** — daily spend over time with forecast
- **Budget utilisation bar** — current MTD spend vs. configured budget
- **Projected monthly spend** — based on current trajectory
- **Top resources** — highest-spending resources within the pool
- **Move pool** — reparent the pool under a different parent (with cycle prevention)

Resources are assigned to pools either:
- **Manually**: Edit a resource and select a pool.
- **Automatically**: Via [Assignment Rules](#119-assignment-rules).

### 8.3 Shared Environments

**Shared Environments** provides a booking system for shared cloud environments (e.g., staging, QA) to prevent conflicting deployments.

**Summary cards:**

| Card | Shows |
|---|---|
| **Total** | Total number of shared environments |
| **Available** | Environments currently available for booking |
| **Booked** | Environments currently in use |

**Environment statuses:**

| Status | Meaning |
|---|---|
| `available` | Ready to be booked |
| `booked` | Currently allocated to a user/team |
| `maintenance` | Temporarily unavailable |
| `archived` | Retired from use |

**Creating an environment:**

1. Click **New Environment**.
2. Enter a name and configure auto-release settings.
3. Save.

**Booking an environment:**

1. Find an **available** environment card.
2. Click **Book**.
3. Enter start time, end time, and notes.
4. Confirm. A countdown timer shows remaining booking time.
5. Click **Release** to free the environment early when done.

### 8.4 Resource Lifecycle

The **Resource Lifecycle** page automates TTL, idle-shutdown, and cleanup policies for cloud resources.

**Summary cards:**

| Card | Shows |
|---|---|
| **Total Policies** | Number of lifecycle policies defined |
| **Active** | Currently enabled policies |
| **Lifecycle Events** | Total events triggered |

**Tabs:**

| Tab | Purpose |
|---|---|
| **Policies** | Create and manage lifecycle policies; run/evaluate on demand |
| **Event Log** | History of all lifecycle actions (flagged, notified, decommissioned, stopped) |

**Creating a lifecycle policy:**

1. Click **Create Policy**.
2. Choose a **type**:
   - **TTL** — flag/stop/decommission resources older than N days
   - **Idle Shutdown** — flag/stop resources with no activity for N days
3. Set the **threshold** (days) and **action** (flag, notify, stop, decommission).
4. Toggle **Active** and save.

**Evaluating a policy:**

Click **Evaluate** on any policy to immediately scan matching resources and generate lifecycle events.

### 8.5 K8s Rightsizing

The **K8s Rightsizing** page provides CPU and memory rightsizing recommendations for Kubernetes workloads.

**KPI cards:**

| Card | Shows |
|---|---|
| **Clusters** | Number of Kubernetes clusters analyzed |
| **Workloads** | Total workloads evaluated |
| **Potential Savings** | Estimated monthly savings from rightsizing |
| **Savings %** | Percentage of current spend that can be saved |

**Views:**

| View | What it shows |
|---|---|
| **Summary** | Horizontal bar chart of top namespaces by savings potential; cluster cards with aggregate metrics |
| **Table** | Detailed workload table with CPU/Memory request → recommended values, P95 usage, and per-workload savings |

**Using filters:**

- Filter by **cluster** or **namespace** to focus the analysis.
- Toggle between Summary and Table views.

### 8.6 Archive

The **Archive** page stores dismissed recommendations and historical alert events.

**Summary cards:**

| Card | Shows |
|---|---|
| **Archived Recommendations** | Count with total deferred savings |
| **Alert Events** | Historical alert trigger count |
| **Reactivatable** | Recommendations that can be restored |

**Tabs:**

| Tab | Purpose |
|---|---|
| **Archived Recommendations** | Browse dismissed/applied recommendations; click **Restore** to reactivate |
| **Alert History** | Browse all alert trigger events with timestamp, cost, and message |

---

## 9. Asset Inventory

The CloudAtlas CMDB (Configuration Management Database) provides a metadata-driven, three-tier association system for tracking all your infrastructure assets.

### 9.1 Configuration Items

#### CI Types

CI Types define the schema for configuration items. CloudAtlas ships with 10 built-in types:

| CI Type | Description |
|---|---|
| `cloud_instance` | Virtual machine (EC2/ECS) |
| `cloud_rds` | Managed relational database |
| `cloud_volume` | Block storage (EBS/Cloud Disk) |
| `cloud_snapshot` | Volume snapshot |
| `cloud_bucket` | Object storage bucket (S3/OSS) |
| `cloud_lb` | Application/network load balancer |
| `cloud_ip` | Static public IP address |
| `reserved_instance` | Cloud reserved compute commitment |
| `savings_plan` | Flexible spend commitment (AWS) |
| `on_prem_server` | Physical/virtual on-premise server |

You can create **custom CI types** for any asset class specific to your organization (e.g., `data_pipeline`, `saas_account`, `network_device`).

**Creating a custom CI type:**

1. Go to **Configuration Items** in the sidebar, then the **CI Types** section.
2. Click **New CI Type**.
3. Fill in:
   - **Name**: Machine-readable identifier (e.g., `data_pipeline`)
   - **Label**: Display name (e.g., `Data Pipeline`)
   - **Icon**: Choose an icon
   - **Classification**: Logical grouping (e.g., `Compute`, `Storage`, `Network`)
4. Add **attributes** to define the schema:
   - Attribute name, label, data type (`string`, `integer`, `boolean`, `datetime`, `json`, `enum`)
   - Mark as required or optional
   - For enum types, define allowed values
5. Save.

#### Configuration Items (CIs)

A CI is a single instance of a CI type — for example, a specific VM named `web-prod-01`.

**Viewing CIs:**

1. Go to **Configuration Items** in the sidebar.
2. Use the **CI Type** filter to narrow the list.
3. Search by name, tag, or metadata field.
4. Click a CI to open the detail drawer, which shows:
   - Basic info (name, type, cloud account, region, lifecycle state)
   - Tags and custom metadata
   - Associated expenses (linked cost data)
   - Associations (upstream and downstream relationships)
   - Change history (audit trail of all modifications)

**Lifecycle states:**

| State | Meaning |
|---|---|
| `provisioning` | Resource is being created |
| `active` | Resource is running and in use |
| `maintenance` | Temporarily taken offline for maintenance |
| `decommissioning` | Scheduled for removal |
| `decommissioned` | Logically removed, may still exist in the cloud |
| `retired` | Fully retired |
| `failed` | Provisioning or runtime failure |

Lifecycle transitions are recorded in the CI audit log with timestamp, actor, and reason.

**Creating a CI manually:**

1. Click **+ Create CI** from the CMDB page.
2. Select the CI type.
3. Fill in the required attributes.
4. Add tags (key-value pairs for cost allocation and filtering).
5. Save.

> Most CIs are created automatically during cloud account sync. Manual creation is useful for on-premises assets or SaaS tools not directly tracked by cloud billing.

### 9.2 Services

Services group related CIs into logical application units (e.g., "E-commerce Platform" = web servers + databases + CDN + message queues).

**Creating a service:**

1. Go to **Services** in the sidebar.
2. Click **New Service**.
3. Enter a name and description.
4. Add CIs to the service by searching and selecting.
5. Save.

**Managing services:**

- View all member CIs and their current lifecycle state
- See aggregated monthly cost for the service (sum of all CI expenses)
- Delete services that are no longer needed
- Map CIs to services from either the Services page or the CI detail drawer

### 9.3 Dynamic Groups

Dynamic groups are saved filters that automatically include CIs matching defined conditions. Unlike static services, membership is evaluated live on every query.

**Example use cases:**
- "All production EC2 instances in us-east-1"
- "All RDS instances with no backup tag"
- "All CIs owned by the platform team"

**Creating a dynamic group:**

1. Go to **Dynamic Groups** in the sidebar.
2. Click **New Group**.
3. Build conditions using the condition editor:
   - CI type, tag value, attribute value, lifecycle state, region, cloud account
   - Combine conditions with AND / OR logic
4. Click **Execute** to preview matching CIs before saving.
5. Save.

### 9.4 Classifications

**Classifications** group CI types into logical categories for organizational purposes.

**Built-in classifications:**

| Classification | Description |
|---|---|
| `cloud_compute` | Virtual machines and containers |
| `cloud_storage` | Disks, snapshots, object storage |
| `cloud_network` | Load balancers and IP addresses |
| `cloud_commitment` | Reserved instances and savings plans |
| `cloud_database` | Managed database services |
| `on_premise` | Physical and virtual on-prem assets |

**Managing classifications:**

1. Go to **Classifications** in the sidebar.
2. Create new classifications with a name, display name, description, icon (emoji), and sort order.
3. Edit existing classifications (built-in ones are read-only).
4. Each classification shows the count of CI types assigned to it.

### 9.5 Associations

Associations describe relationships between CIs using a three-tier model:

```
Association Kind  (vocabulary: "depends_on", "runs_on")
  └── Type Mapping  (schema rule: ec2_instance → ebs_volume allowed)
        └── Instance Association  (actual link: web-01 → vol-abc123)
```

**Tabs on the Associations page:**

| Tab | Purpose |
|---|---|
| **Association Kinds** | Define relationship types (e.g., "depends_on", "runs_on", "connects_to"); set as directional or bidirectional |
| **Type Mappings** | Define valid source-type → kind → destination-type connections with cardinality (one_to_one, one_to_many, many_to_many) |

**Built-in association kinds:**

| Kind | Description |
|---|---|
| `belong_to` | CI belongs to a parent CI |
| `run_on` | CI runs on another CI |
| `backed_by` | CI is backed by a storage CI |
| `connects_to` | Network connection between CIs (bidirectional) |
| `contains` | CI contains sub-CIs |
| `managed_by` | CI is managed by a service or team |

**Linking two CIs:**

1. Open a CI detail drawer.
2. Click **+ Link CI** in the Associations section.
3. Select the association kind.
4. Search for and select the target CI.
5. Save.

**Impact analysis:**

From any CI, click **Impact Analysis** to see all CIs that depend on it (downstream) or that it depends on (upstream), using BFS traversal with configurable depth. This is invaluable for change impact assessment.

### 9.6 Model Topology

The **Model Topology** page provides a visual graph map of all CI types and their relationships in the CMDB.

**Features:**

- **Interactive SVG canvas** with circular node layout
- **Color-coded by classification** (hardware, network, software, etc.)
- **Hover** a node to preview its relationships
- **Click** a node to highlight its connections and view details in the side panel (name, classification, CI count, connection list)
- **Color legend** showing classification-to-color mapping

This page is useful for understanding the overall schema of your CMDB at a glance and identifying missing relationships.

### 9.7 Service Templates

**Service Templates** define standard service topologies as reusable CI type blueprints.

**Creating a template:**

1. Go to **Service Templates** in the sidebar.
2. Click **New Template**.
3. Enter a name, service type, and description.
4. Add CI type items to the template:
   - Select a CI type
   - Define its **role** in the service (e.g., "web", "database", "cache")
   - Set **min/max count** constraints
   - Mark as **required** or optional
5. Save.

**Using templates:**

Templates serve as blueprints when creating new services — the template defines which CI types should be included and their roles, ensuring consistency across similar services.

### 9.8 CI Import

**CI Import** allows bulk-importing configuration items into the CMDB using CSV data.

**Import workflow:**

1. Go to **CI Import** in the sidebar.
2. Set **default values**:
   - Default CI type (applied to all rows unless overridden)
   - Default lifecycle state (e.g., `active`)
3. Provide CSV data:
   - **Paste** CSV directly into the text area, or
   - **Upload** a `.csv` file, or
   - Click **Load example** to see the expected format
4. Click **Parse** to preview the first 10 rows.
5. Review the preview table for correctness.
6. Click **Import** (up to 500 CIs per batch).
7. Review the import result summary:
   - **Created** — successfully imported CIs
   - **Skipped** — duplicates or already-existing CIs
   - **Errors** — rows that failed validation with per-row error details

### 9.9 Inventory Stats

The **Inventory Stats** page provides a high-level overview dashboard for the CMDB.

**Summary cards:**

| Card | Shows |
|---|---|
| **Total CIs** | Total configuration items in the CMDB |
| **Total Services** | Number of defined services |
| **Changes (7 days)** | CI modifications in the last week |
| **Open Drift** | Configuration drift violations |

**Charts and panels:**

- **Compliance overview** — progress bar showing overall compliance percentage
- **Lifecycle distribution** — bar chart showing CI count per lifecycle state
- **CI type distribution** — horizontal bar chart of CIs per type
- **Recent activity** — audit table of latest CI changes (auto-refreshes every 60 seconds)

This is a read-only monitoring page — ideal for checking CMDB health at a glance.

### 9.10 CMDB Audit Log

The **CMDB Audit Log** records every create, update, and delete operation on CIs, associations, and CI types.

**Using the audit log:**

1. Go to **CMDB Audit Log** in the sidebar (under Asset Inventory).
2. Filter by **operation type**: create, update, delete, drift, compliance_check, bulk_import.
3. Search by **CI name**.
4. The paginated table shows: CI Name, CI Type, Operation (color-coded badge), User, Timestamp.
5. **Expand** any row to see field-level change diffs (before → after values).

### 9.11 External CMDB

**External CMDB** connects CloudAtlas to CMDB systems you already run, so discovered cloud CIs can be reconciled with an existing source of truth.

**Adding a connection:**

1. Click **New Connection**.
2. Fill in:
   - **Name** — a friendly label
   - **Provider** — `servicenow`, `rest`, or `jira`
   - **Config** — provider-specific JSON (endpoint, credentials, mapping), validated on save
3. Save.

**Running discovery:**

Click **Run Discovery** to scan your active cloud accounts and reconcile discovered CIs against external systems. The result banner reports the discovery status and the number of active accounts processed.

| Provider | Typical use |
|---|---|
| `servicenow` | Sync with a ServiceNow CMDB table |
| `rest` | Any custom REST-based inventory API |
| `jira` | Asset records tracked as Jira issues |

---

## 10. Governance

### 10.1 Compliance

**Compliance policies** define a desired baseline state for CIs and detect drift from that baseline.

**Creating a compliance policy:**

1. Go to **Compliance** in the sidebar.
2. Click **New Policy**.
3. Configure:
   - **Name** and description
   - **Target CI type** (policy applies to all CIs of this type)
   - **Rules** — required attributes, required tags, allowed lifecycle states, etc.
4. Save.

**Running a compliance check:**

1. Open a policy.
2. Click **Run Check**.
3. CloudAtlas evaluates all matching CIs against the policy rules.
4. Results show: compliant count, non-compliant count, and details of each violation.

**Compliance result statuses:**

| Status | Meaning |
|---|---|
| `compliant` | CI meets all policy rules |
| `non_compliant` | CI violates one or more rules |
| `pending` | Check has not yet run for this CI |

### 10.2 Tagging Coverage

Tags are key-value pairs on cloud resources used for cost allocation, filtering, and governance. The **Tagging Coverage** page reports how well your resources comply with the rules defined in [Tagging Policies](#103-tagging-policies).

**Checking coverage:**

The Tagging Coverage page shows:
- **Coverage %** per CI type (% of resources with all required tags)
- **Violating resources** list — CIs missing required tags
- **Tag distribution** — how many resources have each tag value
- **Uncovered cost** — dollar amount of spend on non-compliant resources

### 10.3 Tagging Policies

Where Tagging Coverage is the *report*, **Tagging Policies** is where the *rules* live.

**Creating a policy:**

1. Go to **Tagging Policies** in the sidebar.
2. Click **New Policy**.
3. Configure:
   - **Name** and optional description
   - **Required tags** — comma-separated list (e.g., `env, team, owner`)
   - **Applies to** — comma-separated resource types, or leave empty for all resources
4. Save.

**Managing policies:**

- Policies are listed with their required-tag chips, scope, and active status.
- **Edit** or **Delete** from the row actions.
- Coverage numbers on the [Tagging Coverage](#102-tagging-coverage) page are computed against these policies.

### 10.4 Constraints

**Constraints** are organization-level guardrails evaluated by the scheduler — they complement pool budgets by watching aggregate behavior.

**Constraint types:**

| Type | Description |
|---|---|
| `anomaly` | Alert when a resource's daily cost spikes more than N standard deviations above its rolling 7-day average |
| `resource_count` | Alert when the number of resources of a type exceeds a limit |
| `total_expense` | Alert when the organization's total monthly spend exceeds a threshold |

**Evaluating constraints:**

Click **Evaluate Now** to run all active constraints on demand. Breaches generate events (visible under [Events](#116-events)), notify subscribed webhooks, and appear in anomaly detection when applicable.

### 10.5 Drift Detection

**Drift Detection** catches unauthorized or accidental configuration changes by comparing live CIs against captured baselines.

**Tabs:**

| Tab | Purpose |
|---|---|
| **Drift** | Detected drift records — CI, field path, old → new value diff, detected-at, and status (open / acknowledged) |
| **Baselines** | Captured snapshots — label, CI, JSON snapshot, capture time |

**Capturing a baseline:**

1. Go to the **Baselines** tab and click **Capture Baseline**.
2. Select the CI, optionally label the snapshot (e.g., `pre-migration`), and edit the JSON snapshot if needed.
3. Save.

**Working with drift:**

1. When a CI changes, re-checking against its baseline produces drift records with a red → green value diff.
2. Review each record and click **Acknowledge** once the change is confirmed intentional — acknowledged records stay for audit.

### 10.6 Anomaly Detection

The **Anomaly Detection** page detects unexpected cost spikes and manages constraint-based detection policies.

**Summary cards:**

| Card | Shows |
|---|---|
| **Total Anomalies** | Number of detected cost anomalies |
| **Cost Impact** | Total dollar impact of all anomalies |
| **Active Policies** | Number of active detection policies |

**Tabs:**

| Tab | Purpose |
|---|---|
| **Anomalies** | Bar chart of top deviations + table with resource name, cost, baseline, and z-score |
| **Policies** | Create and manage detection constraint policies |

**Policy types:** — see [Constraints](#104-constraints) for the three supported types (`anomaly`, `resource_count`, `total_expense`).

**Running detection:**

Click **Evaluate Now** to trigger on-demand evaluation of all active policies. New anomalies appear in the Anomalies tab.

### 10.7 Power Schedules

Power schedules automatically start and stop resource groups on a defined schedule, significantly reducing costs for non-production environments.

**Example:** Stop all `dev` EC2 instances at 20:00 on weekdays and start them at 08:00, saving ~60% of their monthly cost.

**Creating a power schedule:**

1. Go to **Power Schedules** in the sidebar.
2. Click **New Schedule**.
3. Configure:
   - **Name**: e.g., `Dev Env — Business Hours`
   - **Timezone**: Your local timezone
   - **Start time**: `08:00` (weekdays)
   - **Stop time**: `20:00` (weekdays)
   - **Days**: Mon–Fri
4. Add **resources** to the schedule:
   - Select CIs by CI type, tag, pool, or region
5. Enable the schedule and save.

CloudAtlas checks schedules every few minutes and triggers start/stop actions via the cloud provider API at the configured times.

> **Note**: Power schedules act on cloud resources via the linked cloud account's credentials. The account must have sufficient IAM permissions to start/stop the targeted resource types.

### 10.8 Apply Rules

**Apply Rules** automatically patches CI attributes based on condition-matching rules, enabling bulk CI updates without manual editing.

**Creating a rule:**

1. Go to **Apply Rules** in the sidebar.
2. Click **Create Rule**.
3. Configure:
   - **CI type filter** — which CI types this rule applies to
   - **Priority** — evaluation order (lower = first)
   - **Active** toggle — enable/disable the rule
   - **Conditions** — add one or more match conditions (field / operator / value):
     - Example: `lifecycle_state = active`
     - Example: `region = us-east-1`
   - **Attributes to apply** — key-value pairs that will be set on matching CIs:
     - Example: `env = production`
4. Save.

**Running a rule:**

1. Click **Run** on any rule to execute it immediately.
2. The result banner shows: applied count, skipped count, and error count.
3. Matching CIs are updated with the defined attribute values.

**Managing rules:**

- **Edit** rules to change conditions or attributes.
- **Delete** rules that are no longer needed.
- Rules are evaluated in priority order; first match wins.

---

## 11. Administration

### 11.1 Cloud Accounts

Cloud accounts are the source of both resource discovery (CMDB) and billing data (FinOps). CloudAtlas supports **AWS**, **Alibaba Cloud**, and a **Mock** provider for testing.

#### Connecting a Cloud Account

1. Navigate to **Cloud Accounts** in the sidebar.
2. Click **Add Account**.
3. Fill in the form:

   | Field | Description |
   |---|---|
   | **Name** | A friendly label, e.g. `Production AWS` |
   | **Provider** | `aws`, `alibaba`, or `mock` |
   | **Config** | Provider-specific config (account ID, region, etc.) |
   | **Credentials** | Access key / secret key (stored AES-256-GCM encrypted at rest) |

4. Click **Test Connection** to verify credentials before saving.
5. Click **Save**.

**AWS example config:**
```json
{
  "account_id": "123456789012",
  "region": "us-east-1",
  "cur_bucket": "my-billing-bucket",
  "cur_prefix": "billing/"
}
```

**Mock provider** (no real credentials needed, useful for development):
```json
{
  "account_id": "000000000000",
  "region": "us-east-1"
}
```

#### Syncing Resources

After connecting an account, CloudAtlas automatically schedules a sync every hour. You can also trigger a manual sync:

1. Open the cloud account detail page.
2. Click **Sync Now**.
3. The sync job status (`pending → running → completed`) is shown in real time.

Sync does two things:
- **Resource discovery** → creates or updates CIs in the CMDB
- **Billing import** → ingests cost data into the expenses pipeline

### 11.2 Billing Import

The **Billing Import** page triggers billing ingestion on demand instead of waiting for the scheduled run.

**Running an import:**

1. Select the **cloud account** from the dropdown.
2. Set the number of **days** to import (1–90).
3. Click **Run Import**.
4. The result banner reports status, raw rows inserted, days imported, and provider.

**Import history:**

The table at the bottom shows per-account import state: account, provider, raw rows, expense rows created, and last import time. Use it to verify that billing data is flowing before digging into cost pages.

### 11.3 Cost Centers

**Cost Centers** manage a hierarchical cost allocation tree for attributing cloud spend to business units.

**Tree view:**

The page displays cost centers in a nested tree with indentation. Each row shows:

- Name and code
- Owner
- Month-to-date spend
- Action buttons: **+Child**, **Edit**, **Delete**

**Creating a cost center:**

1. Click **New Cost Center** (or **+Child** on an existing node to nest).
2. Fill in:
   - **Name**: e.g., `Engineering`
   - **Code**: e.g., `ENG`
   - **Parent**: Select parent cost center (optional for top-level)
   - **Owner**: Responsible person
   - **Description**: Purpose of this cost center
3. Save.

Cost centers are used in the [Showback](#73-showback) report to allocate costs to business units via the chain: business capabilities → services → CIs → expenses.

### 11.4 Alerts

The **Alerts** page manages budget alert rules and displays alert event history.

**Summary cards:**

| Card | Shows |
|---|---|
| **Total Rules** | Number of configured alert rules |
| **Active Rules** | Enabled alert rules |
| **Events (30d)** | Alert events triggered in the last 30 days |

**Managing alert rules:**

1. Click **Create Alert Rule**.
2. Select a **pool** to monitor.
3. Set the **threshold percentage** (e.g., 80% of budget).
4. Choose notification channel.
5. Save.

**Evaluating alerts:**

Click **Evaluate Now** to trigger on-demand evaluation. When a pool's MTD spend exceeds the configured threshold, an alert event is created and notifications are sent.

**Alert event history:**

The bottom section shows all triggered alert events with:
- Alert rule name
- Trigger time
- Current spend vs. threshold
- Notification status

### 11.5 Alert Events

**Alert Events** is the read-only history of fired budget alerts (the events that the [Alerts](#114-alerts) page produces).

**Using the page:**

1. Filter by type: **All / Absolute / Percentage**.
2. The table shows per event:
   - Alert type badge (absolute = dollar threshold, percentage = % of budget)
   - Threshold (formatted as $ or %)
   - Actual value at trigger time (red)
   - Message and status (Fired / Acknowledged)
   - Triggered timestamp

### 11.6 Events

The **Events** page is a unified, chronological activity feed of alert and webhook events.

**Using the feed:**

1. Filter by kind: **All / Alerts / Webhooks**.
2. Search by title.
3. Events are grouped by day into collapsible cards; each row shows a kind badge (alert = red, webhook = blue), title, raw JSON details, and time.

Use this page for a quick "what happened recently" check without hopping between Alerts and Webhooks.

### 11.7 Webhooks

Webhooks deliver real-time event notifications to external systems (Slack, PagerDuty, custom endpoints). The Webhooks page is also reachable from **Settings → Webhooks**.

**Creating a webhook:**

1. Go to **Webhooks** in the sidebar.
2. Click **Add Webhook**.
3. Configure:
   - **URL**: The HTTPS endpoint to receive events
   - **Events**: Choose which events to subscribe to
   - **Secret** (optional): HMAC signature secret for payload verification
4. Save and use **Send Test** to verify delivery.

**Supported event types:**

| Event | When it fires |
|---|---|
| `budget.exceeded` | A budget alert threshold is crossed |
| `recommendation.created` | A recommendation engine run completes |
| `anomaly.detected` | A constraint violation is detected |
| `resource.discovered` | A cloud account sync completes |

**Webhook payload format:**
```json
{
  "event": "budget.exceeded",
  "timestamp": "2026-05-29T14:32:00Z",
  "org_id": "a0000000-0000-0000-0000-000000000001",
  "data": {
    "message": "Pool 'Engineering' exceeded 80% of budget",
    "pool_name": "Engineering",
    "threshold_pct": 80
  }
}
```

Failed deliveries are retried up to 3 times by the background scheduler.

### 11.8 Integrations

**Integrations** manages third-party notification connections — the managed counterpart to raw webhooks.

**Adding an integration:**

1. Click a provider card (e.g., Slack) in the grid.
2. Fill in the provider-specific fields (token / key / secret — masked input).
3. Save.

**Managing integrations:**

- Each configured integration card shows its status (connected / error) and last-checked time.
- **Test** sends a verification delivery.
- The **active** toggle enables/disables the integration without deleting it.
- **Delete** removes it permanently.

The list of available providers is provided by the server and grows over time.

### 11.9 Assignment Rules

Assignment rules automatically route cloud resources to pools based on conditions, eliminating manual tagging work.

**Creating a rule:**

1. Go to **Rules** in the sidebar.
2. Click **Create Rule**.
3. Define conditions. Supported condition types:

   | Condition | Example |
   |---|---|
   | Tag equals | `env = prod` |
   | Tag contains | `team = platform*` |
   | Resource name matches | `name ~ ^web-` |
   | Cloud account | `account = Production AWS` |
   | Region | `region = us-east-1` |

4. Select the **target pool**.
5. Set **priority** (lower number = evaluated first).
6. Save.

Rules are evaluated in priority order on each sync. The first matching rule wins.

### 11.10 Settings

The **Settings** page provides organization management, member administration, and platform configuration.

**Sections:**

| Section | Purpose |
|---|---|
| **Organization** | Edit organization name, description, currency, and settings |
| **AI Provider** | Configure the org's LLM endpoint: base URL (any OpenAI-compatible API — relay / vLLM / Ollama), API key (encrypted at rest, write-only), chat & embedding models, with a test-connection button. Falls back to server environment settings when not configured |
| **Members** | Invite, edit roles, and remove members |
| **Webhooks** | Configure webhook endpoints for event notifications (see [Webhooks](#117-webhooks)) |
| **Constraints** | Manage organization-level spending constraints (see [Constraints](#104-constraints)) |

#### Environment Variables

Copy `.env.example` to `.env` and configure these variables:

| Variable | Required | Description |
|---|:-:|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string, e.g. `postgres://user:pass@localhost/cloudatlas` |
| `JWT_SECRET` | ✅ | HMAC secret for JWT signing — minimum 32 characters, 64+ recommended for production |
| `ENCRYPTION_KEY` | ✅ | AES-256-GCM key for encrypting cloud credentials — 32 bytes, hex-encoded |
| `CORS_ALLOWED_ORIGINS` | ❌ | Comma-separated allowed origins (default covers `localhost:3000` and `localhost:5173`) |
| `APP_ENV` | ❌ | `development` / `staging` / `production` |
| `APP_PORT` | ❌ | API port (default `8080`) |
| `RUST_LOG` | ❌ | Log filter (default `info,cloudatlas=debug`) |
| `SCHEDULER_ENABLED` | ❌ | Enable the background job runner (default `true`) |
| `SCHEDULER_TICK_SECS` | ❌ | Scheduler tick interval in seconds (default `60`) |
| `CLOUD_MOCK_ENABLED` | ❌ | Set to `true` to enable the mock cloud provider (no real cloud access needed) |
| `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_SECS` | ❌ | Per-IP rate limiting (default 120 requests / 60s) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_FROM` | ❌ | Email channel for webhook notifications |
| `AI_ENABLED` / `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_EMBEDDING_MODEL` | ❌ | AI features; all disabled when the key is empty |
| `VITE_API_BASE_URL` | ❌ | Frontend build-time API base URL |

See [`.env.example`](../.env.example) for the complete annotated reference.

**Generating secure secrets:**
```bash
# JWT_SECRET (64-char random string)
openssl rand -base64 48

# ENCRYPTION_KEY (32 bytes hex-encoded)
openssl rand -hex 32
```

#### Production Hardening

Before deploying to production, complete these steps:

**Security**
- [ ] Rotate `JWT_SECRET` to a freshly generated 64+ character value
- [ ] Rotate `ENCRYPTION_KEY` and store in a secrets manager (AWS Secrets Manager, HashiCorp Vault, K8s Secrets)
- [ ] Place a TLS-terminating reverse proxy (nginx, Caddy, Traefik) in front of both services
- [ ] Enable rate limiting on `/api/v1/auth/*` endpoints
- [ ] Set `CORS_ALLOWED_ORIGINS` to your exact frontend domain (not `*`)

**Database**
- [ ] Enable automated `pg_dump` backups with offsite storage
- [ ] Configure PgBouncer connection pooling for high concurrency
- [ ] Set up a PostgreSQL read replica for analytics queries
- [ ] Tune autovacuum for high-churn tables (`expenses`, `audit_logs`, `ci_audit_logs`)

**Reliability**
- [ ] Configure Kubernetes liveness and readiness probes using `/health` and `/health/ready`
- [ ] Set resource limits on containers
- [ ] Configure log shipping to a centralized log aggregation system

---

## 12. Language & Theme

### Switching language

CloudAtlas ships with a full **English / 中文** translation of every page. To switch:

- Click the **EN / 中文** button in the top-right header.
- The choice is persisted per browser and applied instantly — no reload.
- The language switcher is also available on the **login** and **reset password** screens before you sign in.

### Switching theme

- Click the sun/moon button in the header to toggle **dark / light mode**.
- The preference is saved automatically.

### Global search & Copilot

- The header search box queries across pages and key entities to jump straight to what you need.
- The **Copilot** button (or ⌘/Ctrl+I) opens a right-docked, resizable AI assistant panel that shares the screen with the page you are on — no modal blocking. On narrow screens a floating ✦ launcher appears in the bottom-right corner instead. The panel streams answers, offers page-aware starter suggestions plus a page-context pill, and supports stop/copy on replies. Requires AI features to be enabled (see [AI Center](#64-ai-center)).

---

## 13. API Reference

CloudAtlas provides a fully documented REST API.

- **OpenAPI spec**: `GET http://localhost:8080/api-docs/openapi.json`
- **Swagger UI**: `http://localhost:8080/swagger-ui/`

All API requests to protected endpoints require a `Bearer` token in the `Authorization` header.

### Authentication flow

```bash
# 1. Login
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@acme.com","password":"Password123!"}' \
  | jq -r '.data.access_token')

# 2. Use the token
ORG="a0000000-0000-0000-0000-000000000001"

curl "http://localhost:8080/api/v1/organizations/$ORG" \
  -H "Authorization: Bearer $TOKEN"
```

### Key endpoints

| Area | Endpoint |
|---|---|
| **Auth** | `POST /api/v1/auth/login` · `POST /api/v1/auth/register` · `GET /api/v1/auth/me` |
| **Organizations** | `GET /api/v1/organizations/:id` · `GET /api/v1/organizations/:id/members` |
| **Cloud Accounts** | `GET /api/v1/orgs/:id/cloud-accounts` · `POST /api/v1/orgs/:id/cloud-accounts` |
| **Expenses** | `GET /api/v1/orgs/:id/expenses` · `GET /api/v1/orgs/:id/expenses/summary` |
| **Cost Map** | `GET /api/v1/orgs/:id/expenses/cost-map` · `GET /api/v1/orgs/:id/expenses/unit-economics` · `GET /api/v1/orgs/:id/expenses/region-expenses` |
| **Showback** | `GET /api/v1/orgs/:id/showback` |
| **Pools** | `GET /api/v1/orgs/:id/pools` · `POST /api/v1/orgs/:id/pools` · `PUT /api/v1/orgs/:id/pools/:pid/move` |
| **Budget Matrix** | `GET /api/v1/orgs/:id/pools/budget-matrix` |
| **Recommendations** | `GET /api/v1/orgs/:id/recommendations` · `POST /api/v1/orgs/:id/recommendations/run` |
| **CMDB — CI Types** | `GET /api/v1/orgs/:id/ci-types` · `POST /api/v1/orgs/:id/ci-types` |
| **CMDB — CIs** | `GET /api/v1/orgs/:id/cis` · `POST /api/v1/orgs/:id/cis` · `PUT /api/v1/orgs/:id/cis/:cid` |
| **CMDB — Attributes** | `GET /api/v1/orgs/:id/ci-types/:tid/attributes` · `POST /api/v1/orgs/:id/ci-types/:tid/attributes` |
| **CMDB — Associations** | `GET /api/v1/orgs/:id/ci-association-kinds` · `GET /api/v1/orgs/:id/ci-object-associations` |
| **CMDB — Impact** | `GET /api/v1/orgs/:id/cis/:cid/impact?max_depth=3&direction=downstream` |
| **Services** | `GET /api/v1/orgs/:id/services` · `POST /api/v1/orgs/:id/services` |
| **Dynamic Groups** | `GET /api/v1/orgs/:id/dynamic-groups` · `POST /api/v1/orgs/:id/dynamic-groups` |
| **Compliance** | `GET /api/v1/orgs/:id/compliance-policies` · `POST /api/v1/orgs/:id/compliance/evaluate` |
| **Drift** | `GET /api/v1/orgs/:id/ci-drift` · `POST /api/v1/orgs/:id/ci-drift/:did/acknowledge` · `GET/POST /api/v1/orgs/:id/ci-baselines` |
| **External CMDB** | `GET/POST /api/v1/orgs/:id/external-cmdb` · `POST /api/v1/orgs/:id/cmdb/discovery` |
| **S3 Duplicates** | `GET /api/v1/orgs/:id/s3-duplicates` |
| **BI Export** | `GET/POST /api/v1/orgs/:id/bi-exports` · `POST /api/v1/orgs/:id/bi-exports/:bid/run` · `GET /api/v1/orgs/:id/bi-exports/:bid/download` |
| **Billing** | `POST /api/v1/orgs/:id/billing/import` · `GET /api/v1/orgs/:id/billing/history` |
| **AI** | `POST /api/v1/orgs/:id/ai/chat` · `POST /api/v1/orgs/:id/ai/forecast` · `POST /api/v1/orgs/:id/ai/anomalies` · `GET/PUT /api/v1/orgs/:id/ai/settings` |
| **Tagging** | `GET /api/v1/orgs/:id/tagging/coverage` · `GET/POST/PUT/DELETE /api/v1/orgs/:id/tagging-policies` |
| **Alerts** | `GET /api/v1/orgs/:id/alerts` · `POST /api/v1/orgs/:id/alerts/evaluate` · `GET /api/v1/orgs/:id/alert-events` |
| **Events** | `GET /api/v1/orgs/:id/events` |
| **Webhooks** | `GET /api/v1/orgs/:id/webhooks` · `POST /api/v1/orgs/:id/webhooks` |
| **Integrations** | `GET/POST /api/v1/orgs/:id/integrations` · `POST /api/v1/orgs/:id/integrations/:iid/test` |
| **Constraints** | `GET /api/v1/orgs/:id/constraints` · `POST /api/v1/orgs/:id/constraints/evaluate` |
| **Health** | `GET /health` · `GET /health/ready` |

For the full interactive reference, open the **Swagger UI** at `http://localhost:8080/swagger-ui/`.

---

## 14. Troubleshooting

### Cannot log in

- Verify the email and password. Seed admin: `admin@acme.com` / `Password123!`.
- Check that the API container is running: `docker compose ps`.
- Look at API logs: `docker compose logs cloudatlas-api`.

### Cloud account sync fails

- Click **Test Connection** on the cloud account to verify credentials.
- Ensure the IAM user/role has the required read permissions:
  - AWS: `ec2:Describe*`, `rds:Describe*`, `s3:List*`, `ce:GetCostAndUsage`
  - Alibaba: `AliyunECSReadOnlyAccess`, `AliyunBSSReadOnlyAccess`
- Check the sync job status in the cloud account detail page.

### No expenses showing

- Billing import requires a completed sync. Run **Sync Now** on the cloud account.
- For AWS, ensure the CUR (Cost & Usage Report) bucket name and prefix are correct in the account config.
- Check that the date range filter on the Cost Explorer page covers the sync period.
- Set `CLOUD_MOCK_ENABLED=true` and re-sync to test with mock data.

### Recommendations page is empty

- The recommendation engine runs automatically every 4 hours.
- To trigger immediately: go to **Recommendations** and click **Run Engine**, or call `POST /api/v1/orgs/:id/recommendations/run` via the API.
- The engine requires at least 7 days of expense data to generate most recommendation types.

### Anomaly detection not finding anomalies

- Ensure you have at least 7 days of expense data for the rolling baseline.
- Click **Evaluate Now** on the Anomaly Detection page to trigger on-demand evaluation.
- Check that anomaly detection constraint policies are created and active in the **Policies** tab.

### No alerts triggering

- Verify that pool budgets are configured in **Budgets & Quotas → Pool Budgets**.
- Check that alert rules exist in **Budgets & Quotas → Alert Rules**.
- Click **Evaluate Now** to trigger on-demand alert evaluation.
- Review alert event history in the **Archive → Alert History** tab.

### CMDB CI import failing

- Verify CSV format matches the expected columns (name, ci_type, region, tags, etc.).
- Check that the CI type specified in defaults or CSV exists in the system.
- Review per-row error details in the import result summary.
- Maximum batch size is 500 CIs per import.

### Shared environment booking conflicts

- Only one active booking per environment at a time.
- Check the environment status — it must be `available` to book.
- Auto-release settings will free the environment after the configured duration.
- Click **Release** to manually free a booked environment.

### Database migration fails

```bash
# Check migration status
docker compose run --rm cloudatlas-migrate sqlx migrate info

# Re-run migrations manually
docker compose run --rm cloudatlas-migrate
```

### Frontend cannot reach the API

- Ensure `VITE_API_BASE_URL` in the frontend environment matches the API address.
- Check `CORS_ALLOWED_ORIGINS` in your `.env` — it must include the frontend's exact origin (scheme, host, and port).

### AI features are disabled

- Check that `AI_ENABLED=true` and `OPENAI_API_KEY` are set in the backend environment.
- Confirm the key is valid and the model name (`OPENAI_MODEL`) is available to the account.
- Restart the backend after changing AI settings.

### Webhook deliveries failing

- Verify the endpoint URL is reachable from the CloudAtlas host network.
- Check the webhook event log in **Settings → Webhooks** for error details.
- Ensure the endpoint returns HTTP 2xx within 30 seconds.
- Failed deliveries are retried up to 3 times by the background scheduler.

---

*For architecture internals and database schema details, see the [Technical Design Document](./design.md).*  
*For CI/CD setup, see [ci-cd.md](./ci-cd.md).*  
*For API examples, see [api-examples.md](./api-examples.md).*
