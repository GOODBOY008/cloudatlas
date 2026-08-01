# CloudAtlas — Agent Instructions & Task List

> **Platform**: Unified FinOps + CMDB — Rust (Axum) backend, React (TypeScript + Vite) frontend, PostgreSQL-only.
> **Spec reference**: `../docs/superpowers/specs/2026-05-19-finops-unified-spec.md`
> **Architecture**: Modular monolith. No Redis, Kafka, Elasticsearch. PostgreSQL only.

> **✅ FEATURE LOOPS COMPLETE** — Latest: FinOps Cost Map (3 loops, 2026-06-10). Backend builds cleanly, frontend builds cleanly. See `docs/TASKS.md` for details.

---

## Gap Closure — Task Board (2026-09-12)

> **背景**: 与业界成熟方案逐项对标得出;P0 为 CloudAtlas 自身声称有但缺失的硬伤,P1/P2 为成熟 CMDB 平台能力补齐。
> **迁移编号**: 001–037 已合并为 `backend/migrations/001_init.sql`,新迁移从 002 起。

### Round 1 — P0 数据正确性(可并行)

| Task ID | Description | Status | Files |
|---|---|---|---|
| `cmdb-attr-validation` | CI 属性值校验(11 类型/必填/枚举/正则,未知 key 放行),接入 create/update/bulk-import/apply-rule | ✅ Done — 新增 `cmdb/validation.rs`(validate_meta/validate_meta_update,13 单测),接入 create_ci/update_ci/bulk_import_cis/execute_ci_apply_rule,422 ERR_VALIDATION 带逐属性 details | `backend/src/modules/cmdb/validation.rs`(新) |
| `cmdb-unique-constraints` | `ci_unique_constraints` 表 + CRUD + 写入时组合唯一检查 + `is_unique` 属性生效;CITypes 页管理 UI | ✅ Done — 迁移 031 建表(TEXT[] attr_names,BIGINT 时间戳),CRUD 端点 + 写入检查(meta->>'k' 带引号修复),is_unique 属性同路径生效,CITypes 页约束卡片+弹窗,409 ERR_DUPLICATE | `migrations/031_*.sql`, `cmdb/model_handlers.rs`, `CITypes.tsx` |
| `cmdb-lifecycle-matrix` | 生命周期转移矩阵 + `PATCH /cis/:id/lifecycle` 专用端点(校验/审计/事件);PUT 兼容路径同校验 | ✅ Done — validation.rs 转移矩阵(retired/terminated 终态,failed/decommissioning 补恢复路径),PATCH 端点(reason+审计+drift+事件),PUT 同校验,前端下拉仅渲染合法后继 | `cmdb/handlers.rs`, `CMDB.tsx` |
| `cmdb-model-audit` | 模型层变更审计(ci_type/attribute/classification/assoc/service/template 全写路径);审计页加 resource_type 筛选 | ✅ Done — 迁移 031 扩展 ci_audit_logs(ci_id 可空+resource_type/resource_id/resource_name),write_model_audit_log 覆盖 9 类资源写路径,审计查询 LEFT JOIN + resource_type 筛选,前端筛选下拉 | `cmdb/*_handlers.rs`, `CMDBAuditLog.tsx` |
| `cmdb-discovery-real` | 修复 `POST /cmdb/discovery` stub → 真正入队异步发现任务(全部或单账号);按钮移至 CMDB 总览 | ✅ Done — 复用 cloud::launch_sync 真实入队,可选 body.cloud_account_id,202+job_ids+skipped_accounts;按钮移至 CMDB 页,ExternalCMDB 移除;顺带修复 compliance run 对 NULL cloud_provider 的 panic | `cmdb/compliance_handlers.rs`, `modules/jobs` |

### Round 2 — P1 核心能力(后端)

| Task ID | Description | Status | Files |
|---|---|---|---|
| `cmdb-ci-events` | `ci_events` 表 + `ci.*` 五类事件(webhook enqueue + `GET /cmdb/events?after=` 游标);CMDB 总览"变更动态"卡 | ✅ Done — 迁移 032 + events.rs(五类事件全写入路径发射,webhook 双通道),`GET /cmdb/events` 游标+类型筛选,CMDB 页 15s 轮询变更动态卡 | `migrations/032_*.sql`, `webhook/`, `cmdb/` |
| `cmdb-import-export` | 服务端 CSV 导入(校验+冲突策略)+ 模板下载 + 导出(跟随筛选);CIImport 改直传 | ✅ Done — `import_export.rs`:模板端点(表头+示例+枚注)、multipart 导入(逐行 T1/T2 校验+skip|upsert+1000 行上限+同名兜底)、CSV 导出(复用列表筛选);CIImport 页重写为直传+模板下载 | `cmdb/handlers.rs`, `CIImport.tsx`, `CMDB.tsx` |
| `cmdb-fulltext-search` | `pg_trgm` GIN 表达式索引 + `GET /cis/search` 相似度排序 + 全局搜索接入 | ✅ Done — 迁移 033 trgm 表达式索引,`GET /cis/search`(精确命中优先+similarity 排序+meta/tags 兜底),全局搜索 CI 分支改走索引命中面,搜索框提示语双语更新 | `migrations/033_*.sql`, `cmdb/handlers.rs` |
| `cmdb-batch-ops` | batch-update / batch-delete / clone 端点 + CI 列表多选工具栏 | ✅ Done — 三端点(逐条走 T1/T3/T2 校验链,per-id 结果,上限 200),前端批量工具栏(改标签/改生命周期/删除),clone 复制 meta/tags 不复制关联与 resource_id | `cmdb/handlers.rs`, `CMDB.tsx` |
| `cmdb-governance-schedule` | 合规 24h + 漂移 4h 调度任务;drift resolve/ignore 端点;last-run 展示 | ✅ Done — scheduler 两个 acquire_job_lock 任务;drift resolve/ignore 闭环端点 + 全量重扫(痊愈自动 resolved);`GET /compliance/last-run`(job_runs 记录手动+调度);Compliance 页 last-run 徽标,Drift 页解决/忽略按钮 | `scheduler/mod.rs`, `cmdb/compliance_handlers.rs` |

### Round 3 — P1 前端与剩余

| Task ID | Description | Status | Files |
|---|---|---|---|
| `cmdb-field-template-binding` | 字段模板 bind/unbind/types/diff/apply API + UI(模板终于可生效) | ✅ Done — 5 个端点(bind/unbind/types/diff/apply,apply 支持 dry_run+模板优先+审计),新 FieldTemplates 页(CRUD+绑定管理+diff 预览+试运行/应用) | `cmdb/model_handlers.rs`, `FieldTemplates.tsx`(新) |
| `cmdb-instance-topology-ui` | 消费现有 topology 端点的新拓扑页 + `parent_ci_id` 管理(环检测)+ `GET /ci-forest` | ✅ Done — PUT /cis/:id 支持 parent_ci_id/remove_parent(递归 CTE 环检测 422),`GET /ci-forest` 递归森林,新 CITopology 页(类型筛选+树+设父/清父),CMDB drawer 父节点选择器 | `cmdb/handlers.rs`, `CITopology.tsx`(新) |

### Round 4 — P2 集成与进阶(按价值排序)

| Task ID | Description | Status | Files |
|---|---|---|---|
| `cmdb-external-sync` | 外部 CMDB 同步引擎(rest/ServiceNow,pull/push/dry-run,异步任务+日志+调度) | ✅ Done — 迁移 036(ci_type_id/options/sync_interval),`external_sync.rs`(映射/请求构造纯函数+4 单测;pull meta.external_id 锚点 upsert+shallow merge,push 反向映射 cap 200,30s 超时有界分页),POST sync 202 后台+dry-run 预览+GET logs 分页,调度器 5min 轮询;ExternalCMDB 页同步/试运行/历史表 | `cmdb/external_sync.rs`(新), `ExternalCMDB.tsx` |
| `cmdb-stats-trends` | `cmdb_stats_daily` 快照表 + 每日调度 + 趋势端点 + CMDBStats 趋势图 | ✅ Done — 迁移 034,snapshot_cmdb_stats(CTE 一次算 by_type/by_lifecycle/change_count,读时补今天快照),`GET /cmdb/stats/trends?days=`,每日调度任务,CMDBStats 两条 LineChart(CI 总量/每日变更) | `migrations/034_*.sql`, `scheduler/`, `CMDBStats.tsx` |
| `cmdb-k8s-modeling` | K8s 对象(cluster/ns/node/workload/pod)进 CMDB:builtin 类型 + contains/run_on 关联 + 采集管道同步 | ✅ Done — 迁移 035(container 分类+5 builtin 类型+属性+contains/run_on 对象关联),pipeline `sync_k8s_cis` 随每次集群同步 upsert CIs(锚点 cloud_resource_id,发现来源审计),pod 由 ownerReferences 归属 workload,失败不阻断 rightsizing 管道 | `migrations/035_*.sql`, `k8s/`, `cloud/` |
| `cmdb-dynamic-groups-v2` | 分组执行 SQL 下推(去 500 上限)+ 合规策略目标=动态组 | ✅ Done — 条件编译器(字段/操作符白名单+参数绑定+6 单测,键名字符集防注入),execute_dynamic_group 改 SQL 下推+统一分页(去 500 上限);迁移 037 target_type/target_group_id,合规执行器支持动态组目标(组 SQL 解析成员,≤5000);Compliance 表单目标选择器;合规 upsert 批量化(60s→0.5s) | `cmdb/handlers.rs`, `Compliance.tsx` |
| `cmdb-business-capability` | 业务能力 CRUD + CostCenters 页接入 | ✅ Done — GET/POST `/orgs/:id/business-capabilities` + PUT/DELETE(cost_center_id 归属校验,org 从行反查),CostCenters 页能力管理卡(列表/新建/删除/成本中心关联) | `expense/handlers.rs`, `CostCenters.tsx` |

P3 可选项(XLSX、字段分组、列个性化、引用模型、拓扑图位置、进程管理、存量 OpenAPI 回填)默认不做,清单见 spec §3 P3。

---

## Global Theme Design System (2026-05-26)

CloudAtlas supports **dark** (default) and **light** modes, persisted in localStorage via Zustand.

### Architecture

| Layer | Implementation |
|---|---|
| State | `frontend/src/store/themeStore.ts` — Zustand `persist` store with `{ theme: 'dark' \| 'light', toggleTheme() }` |
| HTML class | `Layout.tsx` `useEffect` syncs `dark` class on `<html>` whenever `theme` changes |
| Anti-flash | Inline script in `index.html` reads localStorage and sets `dark` class before React hydrates |
| Tailwind | `darkMode: 'class'` configured in `index.html` CDN script block |
| Toggle UI | Sun/moon icon button in the top-right of the header (`Layout.tsx`) |

### Color Token Map

The sidebar and header in `Layout.tsx` use explicit `class / dark:class` pairs. All other pages use hardcoded dark Tailwind classes; these are remapped to light equivalents by the CSS override block in `index.html` using `html:not(.dark)` selectors.

| Token role | Dark class (default) | Light override |
|---|---|---|
| Page background | `bg-gray-950` | gray-50 |
| Card / panel background | `bg-gray-900` | white |
| Input / secondary bg | `bg-gray-800` | gray-100 |
| Subtle bg | `bg-gray-700` | gray-200 |
| Border (strong) | `border-gray-800` | gray-200 |
| Border (subtle) | `border-gray-700` | gray-300 |
| Primary text | `text-white` | gray-900 |
| Secondary text | `text-gray-300` | gray-600 |
| Muted text | `text-gray-400/500` | unchanged |
| Colored badge bg | `bg-red/green/yellow-900` | -100 equivalents |
| Colored badge text | `text-red/green/yellow-300` | -700 equivalents |
| Hover row/button | `hover:bg-gray-800` | gray-100 |

White text is **restored** on saturated button backgrounds (`bg-indigo-600/500`, `bg-red-500`, `bg-green-500`, `bg-blue-600`, `bg-yellow-500/600`) via exception rules in the CSS block.

### Convention for New Pages / Components

1. **Cards & panels** — use `bg-gray-900 border border-gray-800 rounded-xl`. The CSS override handles light mode automatically.
2. **Page header** — use `<div className="flex items-center justify-between mb-6"><h2 className="text-xl font-semibold text-white">Title</h2></div>`. No extra padding (Layout provides `p-6`).
3. **Root element** — plain `<div className="space-y-6">` or a flex/grid container. Do **not** add `p-6` (double padding) or `mx-auto` (inconsistent centering).
4. **Text** — use `text-white` for values, `text-gray-400` for labels, `text-gray-500` for captions.
5. **Inputs / selects** — `bg-gray-800 border border-gray-700 rounded-lg text-gray-100 focus:ring-2 focus:ring-indigo-500`.
6. **Error / success inline messages** — wrap in `bg-red-900/40 border border-red-700 text-red-400` or `bg-green-900/40 border border-green-700 text-green-400` cards, **not** bare `text-red-600/green-600`.
7. **Chart tooltip** — use the theme-aware `mapTheme.tooltip` pattern (see `CostMap.tsx`) for pages with recharts charts. For simple usage the CSS override covers the default `bg-gray-900` tooltip container.
8. **SVG / canvas elements** (maps, custom drawings) — **must** consume `useThemeStore` directly since CSS overrides cannot affect inline styles. Follow the `mapTheme` object pattern in `CostMap.tsx`.
9. **Dividers** — `divide-gray-800`, never `divide-gray-100` (light dividers are invisible in dark mode).
10. **Buttons (primary)** — `bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg` with `transition-colors`.

---


## Feature Loop Delta — scope=finops Cost Map, 3 loops (2026-06-10)

**Changes shipped:**

- **Backend: 4 new handlers**
  - `cost_map` (`GET /orgs/:id/expenses/cost-map`) — multi-dim cost breakdown with primary/optional secondary GROUP BY; 5-dim whitelist (`service`, `region`, `resource_type`, `cloud`, `pool`); parameterized drill-down filter; returns `{total_cost, nodes:[{key,label,cost,pct,resource_count,children?}], dims}`
  - `unit_economics` (`GET /orgs/:id/expenses/unit-economics`) — per-resource-type aggregates: count, total, avg_daily, avg_per_resource, pct_of_total
  - `region_expenses` (`GET /orgs/:id/expenses/region-expenses`) — world map payload: 60+ AWS/Azure/GCP region lat/lon coordinates, provider color tagging, `pct` share; returns `{expenses:[...], total_cost, start_date, end_date}`
  - `budget_matrix` (`GET /orgs/:id/pools/budget-matrix`) — pool MTD actual vs configured budget; `status` field: `on_track | warning | over_budget | no_budget`

- **Backend: 4 new routes** in `routes.rs` (all guarded by `ensure_org_member`, `budget-matrix` ordered before `/:id` to avoid axum path collision)

- **Frontend: `CostMap.tsx` page** — 4 tabs:
  - **World Map**: `react-simple-maps` `ComposableMap` + `ZoomableGroup`; sqrt-scaled cost bubbles colored by cloud provider; hover tooltip; zoom controls; provider BarChart; region breakdown table with share bars
  - **Treemap**: primary + secondary dim selectors, drill-down filter with breadcrumb, `recharts Treemap` with custom `TreemapCell` renderer, clickable top-nodes table
  - **Unit Economics**: BarChart by resource type + table (count/total/avg_daily/avg_per_resource/pct)
  - **Budget Matrix**: 4 summary cards (over/warning/on_track/no_budget), pool table with utilisation bar and `StatusBadge`

- **Route wiring**: `/cost-map` route added in `App.tsx`; nav item `{ to: '/cost-map', label: 'Cost Map', icon: '🗺' }` added to `Layout.tsx`

- **Type declarations**: `frontend/src/types/react-simple-maps.d.ts` — ambient module types for `react-simple-maps@3.0.0` (no official `@types` package for v3)

- **Smoke tests**: 5 new checks added to `scripts/smoke_test.sh` covering all 4 new endpoints

**Files changed:**
- `backend/src/modules/expense/handlers.rs`
- `backend/src/modules/expense/pool_handlers.rs`
- `backend/src/routes.rs`
- `frontend/src/pages/CostMap.tsx` *(new)*
- `frontend/src/types/react-simple-maps.d.ts` *(new)*
- `frontend/src/App.tsx`
- `frontend/src/components/Layout.tsx`
- `frontend/package.json` (`react-simple-maps@^3.0.0` added)
- `scripts/smoke_test.sh`

**Quality gates:**
- Backend: `cargo check` pass (warnings only, all pre-existing)
- Frontend: `npm run build` pass (1028 kB bundle, 0 TS errors)
- Security: dim whitelist prevents SQL injection in dynamic GROUP BY; all 4 routes require `ensure_org_member`; no runtime external calls (coordinates are static)

---

## Feature Loop Delta — scope=finops, 3 loops (expenses-map + pools)

**Changes shipped:**
- **Backend: 6 new handlers** in `expense/handlers.rs` and `expense/pool_handlers.rs`:
  - `expense_heatmap` — resource-type × ISO-week cost matrix
  - `resource_expense_history` — daily cost history + period comparison + resource metadata
  - `expenses_by_tag_breakdown` — two-level tag hierarchy (key → top values + % share)
  - `pool_expense_trend` — daily spend + 14-point linear regression 30-day forecast per pool
  - `pool_top_resources` — top 20 resources by cost within a pool + daily roll-up sparkline
  - `move_pool` — reparent pool with recursive CTE cycle guard
- **Backend: 6 new routes** registered in `routes.rs`
- **Frontend: Expenses.tsx fully rewritten** — 11 analysis tabs (Overview, By Service, By Region, By Cloud, By Pool, Trend, Top Resources, Forecast, Anomalies, RI Coverage, By Tag) + `ResourceHistoryPanel` slide-in drill-down panel with daily AreaChart, period delta cards, and tags
- **Frontend: Pools.tsx fully rewritten** — `PoolDetailPanel` slide-in panel with expense trend chart, budget utilisation bar, projected monthly spend, top resources chart/table, and reparent move_pool UI; visual collapsible tree view replacing raw JSON; `BudgetBar` component; pool type field in create form; list/tree view toggle

**Files changed:**
- `backend/src/modules/expense/handlers.rs`
- `backend/src/modules/expense/pool_handlers.rs`
- `backend/src/routes.rs`
- `frontend/src/pages/Expenses.tsx`
- `frontend/src/pages/Pools.tsx`
- `frontend/src/types/index.ts`

**Quality gates:**
- Backend: `cargo check` pass (warnings only)
- Frontend: `npm run build` pass (883 kB bundle)



## Feature Loop Delta — scope=finops, ui slice (2026-05-23)

**Changes shipped:**
- Added an archived recommendations route at `/recommendations/archived` with search, restore, and dismissed-metadata display.
- Extended the recommendation list backend payload with `details`, `dismissed_at`, and `dismiss_reason` so archived items can render without extra detail fetches.
- Updated the recommendations page to switch between active and archived views while preserving existing dismiss and run-engine actions.

**Files changed:**
- `backend/src/modules/recommendation/handlers.rs`
- `frontend/src/pages/Recommendations.tsx`
- `frontend/src/App.tsx`
- `frontend/src/types/index.ts`
- `docs/TASKS.md`

**Quality gates:**
- Backend: `cargo check` pass (warnings only)
- Frontend: `npm run build` pass

**Changes shipped:**
- Added a new **Showback** page and sidebar route wiring for `/showback`.
- Added a new **Tagging Coverage** page and sidebar route wiring for `/tagging-coverage`.
- Added an **Evaluate Now** action to the Alerts page that triggers `/orgs/:org_id/alerts/evaluate` and renders the latest trigger summary.

**Files changed:**
- `frontend/src/pages/Showback.tsx`
- `frontend/src/pages/TaggingCoverage.tsx`
- `frontend/src/pages/Alerts.tsx`
- `frontend/src/App.tsx`
- `frontend/src/components/Layout.tsx`
- `frontend/src/types/index.ts`
- `docs/TASKS.md`

**Quality gates:**
- Pending validation after edit.

## Feature Loop Delta — scope=cmdb, 6 loops (2026-06-09)

**Changes shipped:**
- **CMDB drawer bugfixes**: fixed CI drawer API paths to include org prefix for history/impact queries; fixed lifecycle action to use `PUT /orgs/:org_id/cis/:ci_id` with `lifecycle_state` payload.
- **CI Attribute APIs**: added `GET/POST/DELETE /orgs/:org_id/ci-types/:type_id/attributes` handlers with org membership checks, CI type guardrails, builtin protection, enum validation, and conflict handling.
- **Association metadata APIs**: added `GET /orgs/:org_id/ci-association-kinds` and `GET /orgs/:org_id/ci-object-associations` for UI metadata discovery.
- **Lifecycle transition persistence**: `update_ci` now records state transitions into `ci_lifecycle_transitions` when `lifecycle_state` changes.
- **Impact traversal upgrade**: `ci_impact` upgraded from one-hop union query to BFS recursive CTE traversal with `max_depth` and `direction` query controls.
- **CMDB UI expansion**:
  - Added CI drawer association creation flow (`+ Link CI`) using association templates + target CI selection.
  - Added new **Services** page with create/list/delete service and service→CI mapping operations.
  - Added new **Dynamic Groups** page with condition builder and execute-on-demand results panel.
  - Added new **Compliance** page for policies CRUD, compliance check trigger, and results listing.
- **Navigation/route wiring**: added frontend routes and sidebar entries for `/services`, `/dynamic-groups`, `/compliance`.
- **CMDB test expansion**: extended `backend/tests/cmdb_tests.rs` with query DTO defaults, clamp behavior, enum coverage checks, and association request tests (23 passing tests).

**Files changed:**
- `backend/src/modules/cmdb/handlers.rs`
- `backend/src/modules/cmdb/dto.rs`
- `backend/src/routes.rs`
- `backend/tests/cmdb_tests.rs`
- `frontend/src/pages/CMDB.tsx`
- `frontend/src/pages/Services.tsx`
- `frontend/src/pages/DynamicGroups.tsx`
- `frontend/src/pages/Compliance.tsx`
- `frontend/src/components/Layout.tsx`
- `frontend/src/App.tsx`
- `frontend/src/types/index.ts`
- `docs/TASKS.md`

**Quality gates:**
- Backend build: pass (warnings only)
- Frontend build: pass
- CMDB tests: `cargo test --test cmdb_tests` pass (23/23)

---

**Changes shipped:**
- **Bug fix**: `expenses_by_tag` SQL literal `tags->>'$1'` corrected to `tags ->> $1` — showback by tag now returns real data.
- **Constraint evaluation**: `expense_anomaly` (7-day rolling baseline vs yesterday's spend × threshold_factor) and `resource_tag_coverage` (% of resources missing required tags vs `limit_value` floor) now fully evaluated in `POST /constraints/evaluate`.
- **New endpoint**: `GET /orgs/:id/tagging/coverage` — per-policy tag compliance report with `coverage_percent`, `compliant_resources`, `uncovered_cost` per active tagging policy.
- **New endpoint**: `POST /orgs/:id/alerts/evaluate` — on-demand budget alert evaluation; writes `alert_events` rows and stamps `last_triggered_at` when pool spend exceeds threshold. Uses parameterized interval math (no string format injection).
- **New endpoint**: `GET /orgs/:id/showback` — chargeback allocation report; breaks down last 30 days of spend by pool and by cost center (via business_capabilities → services → CIs → expenses join), with `allocation_pct` per bucket and unallocated cost summary.
- **Rec engine enrichment**: `detect_abandoned_volumes`, `detect_abandoned_lbs`, `detect_obsolete_ips`, `detect_abandoned_snapshots`, `detect_volumes_not_attached` now populate `details` JSONB with structured evidence fields (`resource_type`, `reason`, `detection_window_days`, `resource_name`).

**Files changed:**
- `backend/src/modules/tagging/handlers.rs` — bug fix + new `tag_coverage_analysis` handler
- `backend/src/modules/constraints/handlers.rs` — 2 new constraint eval branches
- `backend/src/modules/alert/handlers.rs` — new `evaluate_alerts` handler
- `backend/src/modules/expense/handlers.rs` — new `showback_report` handler
- `backend/src/modules/recommendation/engine.rs` — 5 enriched `details` objects
- `backend/src/routes.rs` — 3 new route registrations

**Remaining FinOps gaps (next loop candidates):**
- Power schedule execution simulation (CRUD only, no scheduler execution)
- Frontend pages for: tagging coverage, showback report, alert evaluate button
- Integration tests for new endpoints

---

## 1. Project Overview

CloudAtlas combines **FinOps cost optimization** and **CMDB asset management** into a single modular Rust monolith backed exclusively by PostgreSQL.

### Tech Stack

| Layer | Technology |
|---|---|
| Backend | Rust 1.78+, Axum 0.7, sqlx 0.7 (PostgreSQL), tokio async |
| Frontend | React 18, TypeScript, Vite, Recharts, TailwindCSS |
| Database | PostgreSQL 15+ (only — no Redis, Kafka, ES) |
| Auth | JWT (jsonwebtoken), Argon2id password hashing |
| OpenAPI | utoipa 4 + utoipa-swagger-ui |
| Observability | tracing + tracing-subscriber (JSON logs) |
| Runtime | Docker + Docker Compose |

### Repository Layout

```
cloudatlas/
├── backend/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs               # Entry point: config, DB pool, scheduler, axum serve
│   │   ├── config.rs             # Config from env vars
│   │   ├── db.rs                 # Pool creation, run_migrations()
│   │   ├── error.rs              # AppError enum → HTTP responses
│   │   ├── state.rs              # AppState { db, config }
│   │   ├── routes.rs             # Router + OpenAPI aggregation
│   │   ├── middleware/
│   │   │   ├── mod.rs
│   │   │   └── auth.rs           # JWT extraction → Extension<Claims>
│   │   └── modules/
│   │       ├── auth/             # register, login, refresh, orgs, members
│   │       ├── cloud/            # cloud accounts CRUD, adapters (AWS/Aliyun/Mock)
│   │       ├── cmdb/             # CI types, CIs, associations (stubs exist)
│   │       ├── expense/          # expenses CRUD, summary, trend, pools
│   │       ├── health/           # /health, /health/ready
│   │       ├── recommendation/   # stubs only — engine not implemented
│   │       └── scheduler/        # no-op stub — not implemented
│   └── migrations/
│       ├── 001_identity.sql      # users, organizations, members, roles, user_roles
│       ├── 002_cloud_accounts.sql # cloud_accounts, sync_jobs
│       ├── 003_cmdb.sql          # ci_types, cis (basic), ci_instance_associations
│       ├── 004_expenses.sql      # expenses, pools, budgets
│       ├── 005_finops.sql        # recommendations
│       ├── 006_scheduler.sql     # scheduler_jobs
│       └── 007_seed.sql          # demo org, users, cloud account, pools, CIs, expenses, recs
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx               # Routes (react-router-dom)
│       ├── components/Layout.tsx # App shell + sidebar
│       ├── lib/api.ts            # axios base client
│       ├── lib/auth.ts           # token storage helpers
│       ├── types/index.ts        # TypeScript interfaces
│       └── pages/
│           ├── Login.tsx         # ✅ done
│           ├── Dashboard.tsx     # ⚠️ skeleton
│           ├── Expenses.tsx      # ⚠️ skeleton
│           ├── CloudAccounts.tsx # ⚠️ skeleton
│           ├── Pools.tsx         # ⚠️ skeleton
│           ├── Recommendations.tsx # ⚠️ skeleton
│           └── CMDB.tsx          # ⚠️ skeleton
├── docker/
│   ├── backend.Dockerfile        # ⚠️ needs cargo-chef multi-stage
│   ├── frontend.Dockerfile       # ⚠️ needs nginx SPA config
│   └── migrate.Dockerfile        # ⚠️ needs implementation
├── docker-compose.yml            # ✅ prod-like stack
├── docker-compose.dev.yml        # dev hot-reload stack
├── Makefile                      # ✅ complete
├── .env.example                  # ✅ present
└── README.md                     # needs update
```

---

## 2. Coding Standards & Patterns

### Rust Backend Conventions

```rust
// Module structure: every module has mod.rs + handlers.rs + models.rs + dto.rs (+ service.rs if complex)
pub mod auth;
pub mod cmdb;

// Error handling: use AppError from error.rs, return AppResult<T>
pub type AppResult<T> = Result<T, AppError>;

// Handler signature pattern:
pub async fn list_foos(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,      // from JWT middleware
    Path(org_id): Path<Uuid>,
    Query(q): Query<FooQuery>,
) -> AppResult<Json<Value>> { ... }

// Database queries: sqlx with bind params, never format! with user data
let rows = sqlx::query_as::<_, Foo>(
    "SELECT id, name FROM foos WHERE org_id = $1 AND deleted_at = 0 ORDER BY created_at DESC"
)
.bind(org_id)
.fetch_all(&state.db).await?;

// Soft deletes: use deleted_at = 0 (active) or UNIX timestamp (deleted)
// Timestamps: BIGINT UNIX epoch (seconds) for all created_at, updated_at, deleted_at
// UUIDs: gen_random_uuid() in DB, uuid::Uuid in Rust

// OpenAPI: annotate all public handlers with #[utoipa::path(...)]
// Logging: use tracing::info!/warn!/error! with structured fields
// No unwrap() in production paths — use ? operator or map_err
```

### SQL Migration Conventions

```sql
-- File naming: NNN_description.sql (e.g., 008_cmdb_extended.sql)
-- Always include: deleted_at BIGINT NOT NULL DEFAULT 0
-- Always include: created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
-- Always include: updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
-- Indexes: prefix idx_{table}_{column}, always WHERE deleted_at = 0 for partial indexes
-- Soft delete uniqueness: UNIQUE(org_id, name, deleted_at) pattern
-- UUIDs: UUID PRIMARY KEY DEFAULT gen_random_uuid()
```

### Frontend Conventions

```typescript
// API calls go through src/lib/api.ts (axios instance with auth interceptor)
// Types defined in src/types/index.ts
// Pages in src/pages/, reusable components in src/components/
// Use React Query (TanStack Query) for server state
// Use Zustand for client state (auth, UI)
// Error handling: show toast notifications for API errors
// Loading states: skeleton components during data fetch
```

---

## 3. What Is Already Implemented

### ✅ Backend (Complete)
- Auth module: register, login, refresh, JWT middleware, org CRUD, members
- Cloud accounts: CRUD, test connection, trigger sync, sync job history
- Cloud adapters: MockAdapter (full), AwsAdapter (discovery stub), AliyunAdapter (signing stub)
- Expense module: list, summary, by_cloud, by_pool, by_service, trend, top_resources
- Pool module: CRUD for pools/budgets
- CMDB: basic CI type CRUD, CI CRUD (basic), association stubs, history stub
- Scheduler: no-op stub registered in tokio::spawn
- Recommendation: stub handlers returning empty data
- Migrations 001–007 including seed data
- OpenAPI/Swagger at `/swagger-ui`
- Health endpoints `/health` + `/health/ready`
- Docker Compose (prod + dev), Makefile

### ✅ Frontend (Skeleton)
- App routing (react-router)
- Layout with sidebar
- Login page with JWT auth
- Page skeletons: Dashboard, Expenses, CloudAccounts, Pools, Recommendations, CMDB

---

## 4. Remaining Task List

Tasks are ordered by dependency. Complete items marked with ✅, pending marked with 📋.

### Phase A — Database Schema Completion

#### ✅ `db-cmdb-schema` — CMDB Extended Schema
**Goal**: Add all CMDB tables from spec Section 4.4.

**File**: `backend/migrations/008_cmdb_extended.sql`

**Tables to add**:
- `ci_classification` — groups of CI types (cloud_compute, storage, network, commitment)
- `ci_attribute` — dynamic field definitions per CI type
- `ci_association_kind` — relationship type registry (belong, run, connect, contain, backed_by)
- `ci_object_association` — schema-level relationship definitions (src_type ↔ dest_type)
- `ci_instance_association` — data-level CI relationships with properties JSONB
- `ci_unique_constraint` — uniqueness rules per CI type
- `ci_audit_log` — polymorphic audit trail (pre_data/cur_data/update_fields JSONB)
- `ci_lifecycle_transition` — lifecycle state change log
- `ci_dynamic_group` — saved filter definitions
- `service` + `service_ci` — application/service to CI mapping
- `ci_baseline` + `ci_drift` — configuration drift detection
- `compliance_policy` + `ci_compliance` — security posture
- `cost_center` + `business_capability` — financial hierarchy
- `external_cmdb_config` + `external_cmdb_sync_log` — external CMDB integration

**Seed builtin data in same migration**:
```sql
-- 4 classifications: cloud_compute, storage, network, commitment
-- 6 association kinds: belong, run, connect, contain, backed_by, default
-- builtin attributes for each CI type (cpu_count, ram, flavor, os, etc.)
```

**Acceptance criteria**: `cargo sqlx migrate run` succeeds. All tables visible in psql.

---

#### ✅ `db-finops-schema` — FinOps Extended Schema
**Goal**: Add all FinOps tables not yet in schema.

**File**: `backend/migrations/009_finops_extended.sql`

**Tables to add**:
```sql
-- resource table (full resource record with JSONB meta)
CREATE TABLE resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    cloud_account_id UUID NOT NULL REFERENCES cloud_accounts(id),
    cloud_resource_id VARCHAR(256) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,  -- instance | volume | bucket | rds_instance | etc
    service_name VARCHAR(100),
    name VARCHAR(512),
    region VARCHAR(100),
    tags JSONB DEFAULT '{}',
    meta JSONB DEFAULT '{}',
    pool_id UUID REFERENCES pools(id),
    first_seen BIGINT NOT NULL,
    last_seen BIGINT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    total_cost NUMERIC(14,6) DEFAULT 0,
    last_expense JSONB DEFAULT '{}',
    recommendations JSONB DEFAULT '{}',
    dismissed_recommendations JSONB DEFAULT '{}',
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    deleted_at BIGINT NOT NULL DEFAULT 0,
    UNIQUE(organization_id, cloud_account_id, cloud_resource_id, deleted_at)
);

-- raw_expenses (billing line items with cloud-specific JSONB)
CREATE TABLE raw_expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cloud_account_id UUID NOT NULL REFERENCES cloud_accounts(id),
    resource_id VARCHAR(256) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    cost NUMERIC(14,6) NOT NULL,
    box_usage BOOLEAN DEFAULT FALSE,
    report_identity VARCHAR(256),
    cloud_specific JSONB NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(cloud_account_id, resource_id, start_date, report_identity)
);

-- rules + conditions
CREATE TABLE rules ( ... );
CREATE TABLE conditions ( ... );

-- pool_alerts
CREATE TABLE pool_alerts ( ... );

-- organization_constraints
CREATE TABLE organization_constraints ( ... );

-- webhooks
CREATE TABLE webhooks ( ... );

-- power_schedules + power_schedule_triggers
CREATE TABLE power_schedules ( ... );
CREATE TABLE power_schedule_triggers ( ... );

-- checklist (recommendation run state)
CREATE TABLE checklist ( ... );
```

**Acceptance criteria**: Migration runs clean. Existing tests still pass.

---

#### ✅ `db-seed-extended` — Extended Seed Data
**File**: `backend/migrations/010_seed_extended.sql`

Add:
- Builtin CI classifications and association kinds
- Builtin CI attributes for all 12 resource types
- Demo services, cost centers, business capabilities
- Sample compliance policies

---

### Phase B — Backend Core Services

#### ✅ `be-rbac` — RBAC Enforcement
**Goal**: Replace membership-only check with role-based permission enforcement.

**File**: `backend/src/middleware/rbac.rs`, `backend/src/modules/auth/permissions.rs`

**Implementation**:
```rust
pub enum Permission {
    ViewExpenses,
    ManagePools,
    ManageCloudAccounts,
    ManageCmdb,
    ManageRules,
    AdminOrg,
}

pub async fn has_permission(
    db: &PgPool,
    user_id: Uuid,
    org_id: Uuid,
    permission: Permission,
) -> AppResult<()> { ... }
```

**Role mapping**:
- `Owner` → all permissions
- `FinOps` → ViewExpenses, ManagePools, ManageCloudAccounts
- `CMDB Editor` → ManageCmdb
- `Member` → ViewExpenses (read-only)

**Acceptance criteria**: Unauthorized user gets 403 on protected endpoints. Owner can do everything.

---

#### ✅ `be-audit-log` — Audit Log Module
**Goal**: Record all mutating operations to `ci_audit_log`.

**File**: `backend/src/modules/audit/service.rs`

```rust
pub struct AuditService;

impl AuditService {
    pub async fn log(
        db: &PgPool,
        org_id: Uuid,
        audit_type: &str,       // "model_instance"
        action: &str,           // "create" | "update" | "delete"
        resource_type: &str,    // "ci" | "ci_type" | etc
        resource_id: &str,
        resource_name: &str,
        changed_by: Option<Uuid>,
        operate_from: &str,     // "user" | "discovery" | "sync"
        pre_data: Value,
        cur_data: Value,
        request_id: Option<&str>,
    ) -> AppResult<()>
}
```

**Acceptance criteria**: Every CI create/update/delete produces an audit log entry.

---

#### ✅ `be-scheduler` — Background Scheduler
**Goal**: Replace no-op stub with a working cron scheduler.

**File**: `backend/src/modules/scheduler/mod.rs`

**Jobs to implement**:
```rust
// Every 1 hour: sync all active cloud accounts
// Every 4 hours: run recommendation engine
// Every 1 hour: check budget alerts
// Every 24 hours (2am): generate cost forecasts
// On-demand: triggered by POST /cloud-accounts/:id/sync

use cron::Schedule;
use tokio::time::{interval, Duration};

pub async fn start(state: AppState) {
    // spawn separate tokio tasks per job
    // use scheduler_jobs table for state tracking
}
```

**Acceptance criteria**: Scheduler starts, logs job executions, handles errors gracefully.

---

#### ✅ `be-billing-import` — Billing Import Pipeline
**Goal**: Implement two-phase billing import pipeline.

**Files**: `backend/src/modules/cloud/importer/`

**Phase 1 — load_raw_data()**:
```rust
// Parse cloud billing records
// Classify resource_type using rules from spec Section 4.3
// Set box_usage flag
// Compose resource_id per cloud rules
// Upsert into raw_expenses table
```

**Phase 2 — generate_clean_records()**:
```rust
// Group raw_expenses by resource_id + date
// Aggregate cost + usage
// Upsert into expenses table
// Upsert into resources table with meta JSONB
// Update pool assignment via rules engine
```

**Resource type classification rules** (AWS CUR):
```rust
match (line_item_type, product_family, usage_type, product_code) {
    (t, _, _, _) if t == "RIFee" || t == "DiscountedUsage" => ResourceType::ReservedInstances,
    (t, _, _, _) if t.starts_with("SavingsPlan") => ResourceType::SavingsPlan,
    (_, "Compute Instance", u, _) if u.contains("BoxUsage") => ResourceType::Instance,
    // ... etc per spec table
}
```

**Acceptance criteria**: Mock adapter generates expenses that appear in `/expenses/summary`.

---

#### ✅ `be-aws-cur` — AWS CUR Importer
**Goal**: Real AWS Cost and Usage Report ingestion.

**File**: `backend/src/modules/cloud/adapters/aws.rs` (extend existing)

- Download CUR files from S3 (CSV.GZ format)
- Parse CUR columns to `RawExpense` structs
- Apply AWS classification rules
- Handle RI/SP special line items

---

#### ✅ `be-aliyun-bss` — Aliyun BSS Importer
**Goal**: Real Alibaba Cloud billing API ingestion.

**File**: `backend/src/modules/cloud/adapters/aliyun.rs` (extend existing)

- Call `DescribeInstanceBill` API (HMAC-SHA1 signing already implemented)
- Parse BSS fields to `RawExpense` structs
- Apply Alibaba classification rules
- Handle subscription amortization

---

#### ✅ `be-rec-engine` — Recommendation Engine Framework
**Goal**: Pluggable recommendation module framework backed by `checklist` table.

**File**: `backend/src/modules/recommendation/engine/`

```rust
#[async_trait]
pub trait RecModule: Send + Sync {
    fn module_name(&self) -> &str;
    async fn analyze(&self, state: &AppState, org_id: Uuid) -> AppResult<Vec<RecommendationResult>>;
}

pub struct RecEngine {
    modules: Vec<Box<dyn RecModule>>,
}

impl RecEngine {
    pub async fn run_for_org(&self, state: &AppState, org_id: Uuid) -> AppResult<ChecklistResult> {
        // 1. Update checklist.last_run
        // 2. Run all modules concurrently (tokio::join!)
        // 3. Upsert results into recommendations table
        // 4. Archive removed recommendations
        // 5. Update checklist.last_completed
    }
}
```

---

#### ✅ `be-rec-idle` — Idle Resource Recommendations
**Goal**: 8 idle resource recommendation types.

**File**: `backend/src/modules/recommendation/modules/idle.rs`

| Type | Condition | Threshold |
|---|---|---|
| `abandoned_instance` | CPU < 5% AND net < 1000 bps for 7d | Configurable |
| `volumes_not_attached` | volume.meta.state = "available" for 1d | 1 day |
| `obsolete_ips` | ip.meta.associated = false for 7d | 7 days |
| `abandoned_load_balancers` | no traffic metrics for 7d | 7 days |
| `instances_for_shutdown` | recurring inactivity periods | 14 days |
| `s3_abandoned_buckets` | object_count < 1 for 7d | 7 days |

Implementation: query `expenses` and `resources` tables. No external metrics needed — use expense trend as proxy.

---

#### ✅ `be-rec-rightsizing` — Rightsizing Recommendations
**Goal**: 3 rightsizing types.

**File**: `backend/src/modules/recommendation/modules/rightsizing.rs`

- `rightsizing_instances`: avg daily cost / running days, check for consistent overspec
- `rightsizing_rds`: similar for RDS
- `instance_generation_upgrade`: detect m4/m5 instances where m6i is cheaper

**Savings calculation**: `current_type_cost - next_smaller_type_cost * 30`

---

#### ✅ `be-rec-storage` — Storage Recommendations
**Goal**: 5 snapshot/storage types.

**File**: `backend/src/modules/recommendation/modules/storage.rs`

- `obsolete_snapshots`: snapshots older than 3 days with no associated image/volume
- `obsolete_snapshot_chains`: Aliyun snapshot chains
- `snapshots_with_non_used_images`: snapshots backing unused AMIs
- `s3_intelligent_tiering`: buckets with infrequent access patterns

---

#### ✅ `be-rec-commitment` — Commitment Recommendations
**Goal**: RI/savings plan recommendations.

**File**: `backend/src/modules/recommendation/modules/commitment.rs`

- `reserved_instances`: on-demand instances with 90+ days of consistent usage
- `instance_subscription`: Aliyun PAYG vs subscription cost comparison

---

#### ✅ `be-rec-security` — Security Recommendations
**Goal**: 4 security issue types.

**File**: `backend/src/modules/recommendation/modules/security.rs`

- `insecure_security_groups`: SGs with port 22/3389 from 0.0.0.0/0
- `s3_public_buckets`: buckets with public policy
- `inactive_users`: IAM users inactive for 90d
- `inactive_console_users`: console unused but API keys active

---

#### ✅ `be-budgets-alerts` — Budget and Pool Alert Module
**Goal**: Pool budget tracking and threshold alerts.

**Files**: `backend/src/modules/alert/`

```
POST   /api/v1/orgs/:org_id/pools/:pool_id/alerts
GET    /api/v1/orgs/:org_id/pools/:pool_id/alerts
DELETE /api/v1/orgs/:org_id/pools/:pool_id/alerts/:id
```

**Alert types**: ABSOLUTE (dollar threshold), PERCENTAGE (% of budget)
**Evaluation**: Run hourly. Compare current month spend to threshold. Fire once per threshold crossing.

---

#### ✅ `be-rules` — Assignment Rules Engine
**Goal**: Automatic resource-to-pool assignment based on conditions.

**Files**: `backend/src/modules/rules/`

```
GET    /api/v1/orgs/:org_id/rules
POST   /api/v1/orgs/:org_id/rules
PUT    /api/v1/orgs/:org_id/rules/:id
DELETE /api/v1/orgs/:org_id/rules/:id
POST   /api/v1/orgs/:org_id/rules/apply
```

**Condition types**: `name_is`, `tag_is`, `cloud_is`, `region_is`, `resource_type_is`
**Operator**: `AND` | `OR`
**Action**: assign to pool + owner

---

#### ✅ `be-constraints` — Organization Constraints
**Goal**: Org-level cost constraints and anomaly detection.

**Files**: `backend/src/modules/constraints/`

**Types**:
- `EXPENSE_ANOMALY`: alert if daily spend > (avg * threshold_factor)
- `RESOURCE_COUNT`: alert if resource count > max
- `TOTAL_EXPENSE_LIMIT`: alert if monthly total > limit

---

#### ✅ `be-webhooks` — Webhook Delivery
**Goal**: Outbound webhook notifications.

**Files**: `backend/src/modules/webhook/`

Events: `recommendation.created`, `budget.exceeded`, `anomaly.detected`, `resource.discovered`
Delivery: HTTP POST with JSON payload, 3 retries with exponential backoff.

---

#### ✅ `be-power-schedule` — Power Schedule Module
**Goal**: Scheduled start/stop for cloud resources.

**Files**: `backend/src/modules/power_schedule/`

```
GET/POST/PUT/DELETE /api/v1/orgs/:org_id/power-schedules
GET/POST/DELETE     /api/v1/orgs/:org_id/power-schedules/:id/triggers
```

**Execution**: Scheduler evaluates active schedules every 5 minutes. Calls cloud adapter start/stop API.

---

#### ✅ `be-tagging-policy` — Tagging Policy and Cost Allocation
**Goal**: Tag governance and tag-based cost rollup.

**Files**: `backend/src/modules/tagging/`

- Required tag definitions per CI type
- Missing tag detection (surface as recommendations)
- Cost rollup by tag key/value: `GET /orgs/:id/expenses/by-tag?key=env`

---

### Phase C — CMDB Module (Full Implementation)

#### ✅ `be-cmdb-types` — CMDB Type Registry APIs
**Goal**: Full CRUD for ci_classification, ci_type, ci_attribute.

**Extends**: `backend/src/modules/cmdb/`

```
GET/POST         /api/v1/orgs/:org_id/ci-classifications
GET/PUT/DELETE   /api/v1/orgs/:org_id/ci-classifications/:id

GET/POST         /api/v1/orgs/:org_id/ci-types
GET/PUT/DELETE   /api/v1/orgs/:org_id/ci-types/:id
GET/POST         /api/v1/orgs/:org_id/ci-types/:id/attributes
GET/PUT/DELETE   /api/v1/orgs/:org_id/ci-types/:id/attributes/:attr_id
```

**Important**: Seed builtin types on org creation event:
- 12 builtin CI types (instance, volume, snapshot, bucket, rds_instance, ip_address, load_balancer, k8s_pod, savings_plan, reserved_instances, image, snapshot_chain)
- 4 builtin classifications (cloud_compute, storage, network, commitment)

---

#### ✅ `be-cmdb-ci` — CI Instance APIs (Full)
**Goal**: Extend stub with real database operations, attribute validation, lifecycle.

**Extends**: `backend/src/modules/cmdb/handlers.rs`

- Validate attribute values against `ci_attribute` schema on create/update
- `inst_id` auto-increment per CI type using sequence or `SELECT MAX(inst_id) + 1 ... FOR UPDATE`
- Lifecycle state machine: `provisioning → active → maintenance → decommissioned → retired`
- Full-text + JSONB search: `GET /cis?q=web-server&region=us-east-1&lifecycle=active`
- Pagination with cursor-based approach

---

#### ✅ `be-cmdb-associations` — Three-Tier Association System
**Goal**: Association kind → object association → instance association.

**File**: `backend/src/modules/cmdb/associations.rs`

```
GET/POST/DELETE  /api/v1/orgs/:org_id/ci-association-kinds
GET/POST/DELETE  /api/v1/orgs/:org_id/ci-object-associations
GET/POST/DELETE  /api/v1/cis/:ci_id/associations
GET              /api/v1/cis/:ci_id/associations?direction=src|dest|both
```

**Cardinality enforcement**: Before inserting instance association, check 1:1 / 1:n / n:n constraints from `ci_object_association.mapping`.

---

#### ✅ `be-cmdb-audit` — CMDB Audit Trail
**Goal**: Polymorphic audit logging on all CMDB mutations.

**File**: `backend/src/modules/cmdb/audit.rs`

```rust
// Call after every CI create/update/delete
audit_service.log(db, org_id, "model_instance", "update", "ci",
    ci_id.to_string(), ci_name, Some(user_id), "user",
    pre_data, cur_data, request_id).await?;
```

```
GET /api/v1/orgs/:org_id/audit-logs?resource_type=ci&from=...&to=...
GET /api/v1/cis/:ci_id/history
```

---

#### ✅ `be-cmdb-topology` — Topology and Impact Analysis
**Goal**: CI topology tree traversal and impact analysis.

**File**: `backend/src/modules/cmdb/topology.rs`

```sql
-- Recursive CTE for topology subtree
WITH RECURSIVE subtree AS (
    SELECT id, name, parent_id, 0 AS depth FROM ci WHERE id = $1
    UNION ALL
    SELECT c.id, c.name, c.parent_id, s.depth + 1
    FROM ci c JOIN subtree s ON c.parent_id = s.id
    WHERE c.deleted_at = 0
)
SELECT * FROM subtree;
```

```
GET /api/v1/cis/:id/topology       -- subtree via parent_id
GET /api/v1/cis/:id/impact         -- all CIs depending on this CI (BFS via associations)
```

---

#### ✅ `be-cmdb-dynamic-groups` — Dynamic Groups
**Goal**: Saved filter execution engine.

**File**: `backend/src/modules/cmdb/dynamic_groups.rs`

```
GET/POST/PUT/DELETE /api/v1/orgs/:org_id/ci-dynamic-groups
POST               /api/v1/orgs/:org_id/ci-dynamic-groups/:id/execute
```

Condition operators: `$eq`, `$ne`, `$in`, `$nin`, `$gte`, `$lte`, `$contains`, `$startswith`
Fields: top-level CI columns + `meta.{key}` JSONB path queries

---

#### ✅ `be-cmdb-services` — Service Mapping
**Goal**: Application/service to CI mapping with cost aggregation.

**File**: `backend/src/modules/cmdb/services.rs`

```
GET/POST/PUT/DELETE /api/v1/orgs/:org_id/services
GET/POST/DELETE     /api/v1/orgs/:org_id/services/:id/cis
GET                 /api/v1/orgs/:org_id/services/:id/costs  -- sum of CI expenses
```

---

#### ✅ `be-cmdb-compliance` — Compliance Engine
**Goal**: Policy-based compliance evaluation.

**File**: `backend/src/modules/cmdb/compliance.rs`

```
GET/POST/PUT/DELETE /api/v1/orgs/:org_id/compliance-policies
GET                 /api/v1/cis/:id/compliance
POST                /api/v1/orgs/:org_id/compliance-policies/evaluate  -- run now
```

---

#### ✅ `be-cmdb-drift` — Baseline and Drift Detection
**Goal**: Configuration drift detection against desired state.

**File**: `backend/src/modules/cmdb/drift.rs`

- Baseline captures `desired_state` JSONB
- Drift detection compares `ci.meta` to `ci_baseline.desired_state` on every CI update
- Drift entries created for each divergent field

```
GET/POST/PUT/DELETE /api/v1/cis/:id/baselines
GET                 /api/v1/orgs/:org_id/drift?status=open
PATCH               /api/v1/drift/:id/acknowledge
```

---

#### ✅ `be-cmdb-discovery` — Cloud Discovery → CMDB Sync
**Goal**: Sync cloud-discovered resources into CMDB as CIs.

**File**: `backend/src/modules/cloud/discovery_to_cmdb.rs`

After `discover_resources()` completes:
1. For each `DiscoveredResource`, upsert into `ci` table matching by `cloud_resource_id + cloud_account_id + ci_type_id`
2. Update `meta` and `tags` from discovery data
3. Create builtin associations: Instance → Volume (`belong`), etc.
4. Write audit log entry with `operate_from = 'discovery'`

---

#### ✅ `be-cmdb-external` — External CMDB Integration
**Goal**: Pull/push sync with external CMDBs (ServiceNow, REST).

**File**: `backend/src/modules/cmdb/external_integration.rs`

```
GET/POST/PUT/DELETE /api/v1/orgs/:org_id/external-cmdb
POST                /api/v1/orgs/:org_id/external-cmdb/:id/sync
GET                 /api/v1/orgs/:org_id/external-cmdb/:id/logs
```

---

### Phase D — Frontend Complete Implementation

#### ✅ `fe-state-management` — State Management Setup
**Goal**: Add Zustand + React Query.

**Files**: `frontend/src/stores/`, `frontend/src/lib/queryClient.ts`

```typescript
// authStore.ts
interface AuthStore {
  user: User | null;
  token: string | null;
  currentOrg: Organization | null;
  login(token: string, user: User): void;
  logout(): void;
  setOrg(org: Organization): void;
}

// uiStore.ts
interface UIStore {
  sidebarOpen: boolean;
  notifications: Notification[];
}
```

---

#### ✅ `fe-auth-flow` — Auth Flow and Protected Routes
**Goal**: Complete auth flow with JWT refresh.

**Files**: `frontend/src/lib/auth.ts` (extend), `frontend/src/components/ProtectedRoute.tsx`

- Axios interceptor: attach Bearer token to all requests
- 401 interceptor: attempt refresh, retry once, redirect to login on failure
- ProtectedRoute component wrapping all authenticated pages
- Org selector if user belongs to multiple orgs

---

#### ✅ `fe-dashboard` — Dashboard Implementation
**Goal**: Complete Dashboard page with all widgets.

**File**: `frontend/src/pages/Dashboard.tsx`

Widgets to implement:
- **CostTrend**: `GET /expenses/trend` → Recharts LineChart (30 days)
- **SpendByService**: `GET /expenses/by-service` → Recharts PieChart
- **TopResources**: `GET /expenses/top-resources` → sortable Table
- **RecommendationsCard**: `GET /recommendations/summary` → savings badge + count
- **PoolsBudget**: `GET /pools` → progress bars showing budget % used
- **Summary cards**: total spend, resource count, active recommendations

---

#### ✅ `fe-expenses` — Expenses Page
**Goal**: Complete expense analysis page.

**File**: `frontend/src/pages/Expenses.tsx`

- Date range picker (last 7d / 30d / 90d / custom)
- Filter bar: cloud account, pool, resource type
- Summary metrics row (total, avg daily, resource count)
- Tabs: By Service, By Region, By Cloud, By Pool, Trend
- Paginated expense table with export to CSV

---

#### ✅ `fe-cloud-accounts` — Cloud Accounts UI
**Goal**: Complete cloud account management.

**File**: `frontend/src/pages/CloudAccounts.tsx`

- Account list with status indicators (connected, syncing, error)
- Add account modal: provider selector (AWS / Aliyun / Mock) + credential fields
- Test connection before save
- Trigger sync button with progress indicator
- Sync history table per account

---

#### ✅ `fe-recommendations` — Recommendations Page
**Goal**: Complete recommendations page.

**File**: `frontend/src/pages/Recommendations.tsx`

- Filter by type (idle/rightsizing/storage/security/commitment), status, min savings
- Recommendation cards with type icon, resource link, savings amount, age
- Dismiss action with confirmation
- Trigger manual run button
- Savings summary (total potential, by category)

---

#### ✅ `fe-pools` — Pools Management
**Goal**: Complete pool hierarchy management.

**File**: `frontend/src/pages/Pools.tsx`

- Tree view of pool hierarchy (react-arborist or recursive component)
- Budget progress bars (current spend / budget limit)
- Create/edit/delete pool form
- Pool detail: expense breakdown, assigned resources, team members

---

#### ✅ `fe-cmdb` — CMDB Page
**Goal**: Complete CMDB configuration management UI.

**File**: `frontend/src/pages/CMDB.tsx`

- Left panel: CI type classification tree
- Main area: CI list with search (name, tag, region) and lifecycle filter
- CI detail drawer: dynamic attribute form, associations list, cost badge, history timeline
- Create CI form with dynamic field schema from `ci_attributes`
- Lifecycle state badge with transition action buttons

---

#### ✅ `fe-settings` — Settings Page
**Goal**: Org settings and member management.

**File**: `frontend/src/pages/Settings.tsx`

- Org profile (name, currency, description)
- Member list with role badges
- Invite member (email → sends invite)
- Remove member
- Role assignment dropdown

---

### Phase E — DevOps & Infrastructure

#### ✅ `docker-backend` — Backend Dockerfile (Multi-Stage)
**Goal**: Production-ready, cache-optimized Rust Docker build.

**File**: `docker/backend.Dockerfile`

```dockerfile
# Stage 1: Chef — dependency cache layer
FROM rust:1.78-bookworm AS chef
RUN cargo install cargo-chef
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# Stage 2: Builder
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --bin cloudatlas

# Stage 3: Runtime
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y ca-certificates wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/cloudatlas .
COPY --from=builder /app/migrations ./migrations
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["./cloudatlas"]
```

---

#### ✅ `docker-frontend` — Frontend Dockerfile (Multi-Stage)
**Goal**: Optimized nginx-based SPA container.

**File**: `docker/frontend.Dockerfile`

```dockerfile
# Stage 1: Builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
ARG VITE_API_BASE_URL=/api/v1
RUN npm run build

# Stage 2: Runtime (nginx)
FROM nginx:alpine AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

**nginx.conf**:
```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  # API proxy
  location /api/ {
    proxy_pass http://api:8080;
    proxy_set_header Host $host;
  }

  # SPA fallback
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

---

#### ✅ `docker-migrate` — Migration Dockerfile
**Goal**: Standalone migration runner container.

**File**: `docker/migrate.Dockerfile`

```dockerfile
FROM rust:1.78-bookworm AS builder
RUN cargo install sqlx-cli --features postgres --no-default-features

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/cargo/bin/sqlx /usr/local/bin/sqlx
COPY backend/migrations /migrations
ENV DATABASE_URL=""
CMD ["sqlx", "migrate", "run", "--source", "/migrations"]
```

---

#### ✅ `docker-dev` — Dev Docker Compose
**Goal**: Lightweight dev stack (PostgreSQL only, backend/frontend run locally).

**File**: `docker-compose.dev.yml`

```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: cloudatlas
      POSTGRES_USER: cloudatlas
      POSTGRES_PASSWORD: cloudatlas
    ports:
      - "5432:5432"
    volumes:
      - pgdata_dev:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cloudatlas"]
      interval: 5s
      timeout: 3s
      retries: 10

  pgadmin:
    image: dpage/pgadmin4:latest
    profiles: [tools]
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@cloudatlas.dev
      PGADMIN_DEFAULT_PASSWORD: admin
    ports:
      - "5050:80"

volumes:
  pgdata_dev:
```

**Dev workflow**: `make dev-db` starts postgres, then `make dev-backend` (cargo watch) + `make dev-frontend` (vite) in separate terminals.

---

#### ✅ `ci-pipeline` — CI/CD Pipeline
**Goal**: GitHub Actions CI pipeline.

**File**: `.github/workflows/ci.yml`

Jobs:
1. `lint`: `cargo clippy -- -D warnings` + `npm run lint`
2. `test`: `cargo test` + `npm test` (with postgres service container)
3. `build`: `cargo build --release` + `npm run build`
4. `docker`: build + tag images (on main branch push)

---

#### ✅ `env-docs` — Environment Variable Documentation
**Goal**: Complete `.env.example` with all variables documented.

```bash
# ── Application ──────────────────────────────────────────────
APP_NAME=cloudatlas
APP_ENV=development         # development | staging | production
APP_HOST=0.0.0.0
APP_PORT=8080

# ── Database ─────────────────────────────────────────────────
DATABASE_URL=postgres://cloudatlas:cloudatlas@localhost:5432/cloudatlas
DB_MAX_CONNECTIONS=20

# ── Auth ─────────────────────────────────────────────────────
JWT_SECRET=<run: openssl rand -hex 64>
JWT_EXPIRY_SECONDS=3600
REFRESH_TOKEN_EXPIRY_SECONDS=604800

# ── Security ─────────────────────────────────────────────────
ENCRYPTION_KEY=<64 hex chars, run: openssl rand -hex 32>

# ── Scheduler ────────────────────────────────────────────────
SCHEDULER_ENABLED=true

# ── Cloud / Mock ─────────────────────────────────────────────
CLOUD_MOCK_ENABLED=false    # true = use mock adapter for all accounts

# ── AWS (real cloud accounts) ────────────────────────────────
# Credentials stored per-account in cloud_accounts.credentials_enc
# These are platform-level defaults only
AWS_DEFAULT_REGION=us-east-1

# ── Aliyun ───────────────────────────────────────────────────
ALIYUN_ENDPOINT=https://business.aliyuncs.com

# ── AI / LLM (optional) ──────────────────────────────────────
OPENAI_API_KEY=             # Leave empty to disable AI features
OPENAI_MODEL=gpt-4o
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
AI_ENABLED=false

# ── Observability ────────────────────────────────────────────
RUST_LOG=info,cloudatlas=debug
```

---

### Phase F — Testing

#### ✅ `be-tests-auth` — Auth Module Tests
```rust
// backend/src/modules/auth/tests.rs
#[tokio::test]
async fn test_register_and_login() { ... }
#[tokio::test]
async fn test_invalid_credentials() { ... }
#[tokio::test]
async fn test_jwt_expiry() { ... }
```

#### ✅ `be-tests-expense` — Expense Module Tests
```rust
// Test: seed expenses → call /expenses/summary → verify totals
// Test: date range filtering
// Test: by_service and by_cloud aggregation
```

#### ✅ `be-tests-rec` — Recommendation Engine Tests
```rust
// Test: abandoned instance detection with synthetic expense data
// Test: orphan volume detection
// Test: rightsizing with simulated low CPU history
```

#### ✅ `be-tests-cmdb` — CMDB Module Tests
```rust
// Test: CI create → attribute validation → read
// Test: lifecycle state transition
// Test: association cardinality enforcement
// Test: topology CTE traversal
```

#### ✅ `be-smoke-tests` — API Smoke Test Script
**File**: `scripts/smoke_test.sh`

```bash
#!/bin/bash
BASE=http://localhost:8080/api/v1

# Register + login
TOKEN=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"Test1234!","display_name":"Test User"}' \
  | jq -r '.access_token')

# Create org
ORG=$(curl -s -X POST $BASE/organizations -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Org"}' | jq -r '.data.id')

# Verify expenses summary
STATUS=$(curl -s -o /dev/null -w "%{http_code}" $BASE/orgs/$ORG/expenses/summary \
  -H "Authorization: Bearer $TOKEN")
[ "$STATUS" = "200" ] && echo "✅ expenses/summary" || echo "❌ expenses/summary ($STATUS)"
```

---

### Phase G — Documentation

#### ✅ `docs-readme` — README Update
Update `cloudatlas/README.md` with:
- Architecture diagram (ASCII)
- Quick start: `docker compose up`
- API reference: `http://localhost:8080/swagger-ui`
- Development setup
- Makefile reference

#### ✅ `docs-openapi` — OpenAPI Completeness
Ensure all route handlers have `#[utoipa::path(...)]` annotations and are registered in `ApiDoc` struct in `routes.rs`.

#### ✅ `docs-adr` — Architecture Decision Records
Write `docs/adr/` entries:
- `ADR-001-modular-monolith.md`
- `ADR-002-postgresql-only.md`
- `ADR-003-rust-axum.md`
- `ADR-004-three-tier-association-model.md`

---

## 5. Priority Execution Order

Run tasks in this order to unlock dependent work:

```
Round 1 (parallel, no deps):
  db-cmdb-schema + db-finops-schema + db-seed-extended
  fe-state-management + docker-dev + env-docs

Round 2 (after Round 1):
  be-rbac + be-audit-log + be-billing-import
  be-cmdb-types + fe-auth-flow + docker-backend + docker-migrate

Round 3 (after Round 2):
  be-rec-engine + be-scheduler + be-cmdb-ci
  fe-dashboard + fe-expenses + fe-cloud-accounts

Round 4 (after Round 3):
  be-rec-idle + be-rec-rightsizing + be-rec-storage + be-rec-security + be-rec-commitment
  be-cmdb-associations + be-cmdb-audit + be-cmdb-topology + be-cmdb-dynamic-groups
  fe-recommendations + fe-pools + fe-cmdb

Round 5 (after Round 4):
  be-aws-cur + be-aliyun-bss + be-budgets-alerts + be-rules + be-constraints + be-webhooks
  be-cmdb-services + be-cmdb-compliance + be-cmdb-drift + be-cmdb-discovery
  fe-settings + be-tests-* + be-smoke-tests

Round 6 (after Round 5):
  be-power-schedule + be-tagging-policy + be-cmdb-external
  docker-frontend + ci-pipeline + docs-*
```

---

## 6. Agent Guidance for Each Work Area

### When working on Backend (Rust)

1. **Run migrations first**: `make migrate` before coding against new tables
2. **Follow existing handler patterns**: see `expense/handlers.rs` for reference style
3. **Add OpenAPI annotations**: every new handler needs `#[utoipa::path(...)]`
4. **Register routes in `routes.rs`**: add to the `protected` router
5. **Register modules in `modules/mod.rs`**: add `pub mod your_module;`
6. **Update ApiDoc**: add new paths and schemas to `routes.rs` ApiDoc struct
7. **Test with**: `make api-test` or `cargo test`
8. **Check compilation**: `cargo clippy -- -D warnings`

### When working on Frontend (React/TypeScript)

1. **Follow existing page patterns**: see `Expenses.tsx` for reference
2. **Use React Query**: `useQuery` for GET, `useMutation` for POST/PUT/DELETE
3. **Type everything**: define types in `src/types/index.ts`
4. **Use api.ts**: never call `fetch()` directly — use the configured axios instance
5. **Handle loading/error states**: every query needs loading skeleton and error boundary
6. **Test with**: `npm test` and visual check at `localhost:3000`

### When working on Database Migrations

1. **Always use soft deletes**: include `deleted_at BIGINT NOT NULL DEFAULT 0`
2. **Add partial indexes**: `WHERE deleted_at = 0` on all business queries
3. **Follow naming**: `idx_{table}_{column}` for indexes
4. **Test migration**: `make migrate` then `make migrate-revert` to verify both directions
5. **Don't use DROP in migrations** (irreversible) — use ALTER or CREATE new

### When implementing Recommendation Modules

1. Reference `docs/superpowers/specs/2026-05-19-finops-unified-spec.md` Section 6.2 for all 27 types
2. Each module implements the `RecModule` trait
3. Query expenses table (not raw_expenses) for cost analysis
4. Store results in `recommendations` table with `rec_type`, `status`, `potential_savings`
5. Do not delete old recommendations — set `status = 'archived'` instead

### When implementing CMDB

1. Reference spec Section 4.4 for complete CMDB data model
2. Follow the established naming conventions (`ci_`, `ci_type_`, `ci_association_`)
3. Always write audit log entries via `AuditService::log()`
4. Validate attributes against `ci_attribute` schema before persisting
5. Use `inst_id` (auto-increment per type) not just UUID for human-readable IDs

---

## 7. AI Module (Future Phase)

The following is planned but not yet in scope for initial implementation. Add after core FinOps + CMDB are stable.

### AI Features Roadmap
- **AI Assistant** (chat with tool calling) — SSE streaming chat endpoint
- **Smart Recommendations** — LLM explanations for detected issues
- **Cost Forecasting** — Holt-Winters triple exponential smoothing (in-process, no ML infra)
- **Anomaly Detection** — Z-score + STL decomposition on expense time-series
- **RAG Pipeline** — pgvector embeddings for context retrieval

### AI Configuration (when ready)
Add to `Cargo.toml`:
```toml
# Not yet needed — placeholder for future AI feature branch
# async-openai = "0.23"
```

Add to `.env.example`:
```bash
OPENAI_API_KEY=          # Optional — AI features disabled if empty
OPENAI_MODEL=gpt-4o
AI_ENABLED=false
```

Detailed spec: `../docs/superpowers/specs/2026-05-19-ai-features-design.md`

---

## 8. Quick Reference

### Key API Endpoints (Implemented)
```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
GET    /api/v1/auth/me
POST   /api/v1/organizations
GET    /api/v1/organizations/:id
GET    /api/v1/orgs/:org_id/expenses/summary
GET    /api/v1/orgs/:org_id/expenses/trend
GET    /api/v1/orgs/:org_id/expenses/top-resources
GET    /api/v1/orgs/:org_id/cloud-accounts
POST   /api/v1/orgs/:org_id/cloud-accounts
POST   /api/v1/orgs/:org_id/cloud-accounts/:id/sync
GET    /api/v1/orgs/:org_id/cis
POST   /api/v1/orgs/:org_id/cis
GET    /api/v1/orgs/:org_id/recommendations/summary
GET    /swagger-ui   ← OpenAPI explorer
GET    /health
```

### Seed Credentials (demo)
```
Email:    admin@acme.com
Password: Password123!
Org ID:   a0000000-0000-0000-0000-000000000001
```

### Start the full stack
```bash
cd cloudatlas
docker compose up          # prod-like
# OR
make dev                   # hot-reload dev
```

### Run smoke tests
```bash
make api-test
```

## Delta Note (2026-05-23, FinOps loop x3)
- Added migration `backend/migrations/012_recommendations_dedupe_and_checklist.sql` to dedupe and enforce active recommendation uniqueness.
- Added recommendation checklist status API: `GET /api/v1/orgs/:org_id/recommendations/checklist`.
- Added recommendation list query capabilities (`status`, `rec_type`, `search`, `limit`, `offset`) with total count metadata.
- Corrected billing import history aggregation to avoid row multiplication and safely handle null `last_import`.
- Updated recommendation type unit test set to include extended enum values; targeted tests pass.

## Delta Note (2026-05-23, FinOps+CMDB loop x3, scope=both)

**Gaps closed in this session** — all 6 gaps identified by gap analysis, executed over 3 loops:

### Loop 1 (Resources API — G1)
- Created `cloudatlas/backend/src/modules/resources/` module (`mod.rs` + `handlers.rs`)
- 4 new endpoints wired into `routes.rs`:
  - `GET  /api/v1/orgs/:org_id/resources` — list resources with filters (resource_type, pool_id, cloud_account_id, cloud_region, active, search) + pagination
  - `GET  /api/v1/orgs/:org_id/resources/:resource_id` — detail endpoint
  - `PATCH /api/v1/orgs/:org_id/resources/:resource_id/pool` — reassign pool (validates pool belongs to same org)
  - `PATCH /api/v1/orgs/:org_id/resources/:resource_id/tags` — full tags replacement (validates JSON object)
- Backed by `resources` table from migration 009 which had no handlers prior

### Loop 2 (CI Association DELETE + CI Type DELETE + Checklist PATCH — G2/G3/G5)
- **`DELETE /api/v1/orgs/:org_id/cis/:ci_id/associations/:assoc_id`** — hard-delete from `ci_instance_associations` (table has no `deleted_at`); guarded by org_id + ci membership check
- **`DELETE /api/v1/orgs/:org_id/ci-types/:id`** — hard-delete from `ci_types` (no `deleted_at`); guarded by: (1) is_builtin check, (2) active CI count check (rejects if any CIs use the type)
- **`PATCH  /api/v1/orgs/:org_id/recommendations/checklist`** — upserts checklist row, merges `modules_config` via PostgreSQL `||` JSONB concatenation; returns full merged state

### Loop 3 (Recommendation Re-activate — G4)
- **`POST /api/v1/orgs/:org_id/recommendations/:id/reactivate`** — un-dismisses a recommendation; flips `status` to `active`, clears `dismissed_by`/`dismissed_at`/`dismiss_reason`; returns 409 Conflict if unique active-scope index (migration 012) would be violated; returns 404 if rec not found or not in `dismissed` state

**Quality gates — all loops**:
- `ensure_org_member` on every new handler (tenant isolation)
- All SQL uses `$N` bind parameters (no format!/string interpolation with user data)
- `cargo build` — clean after each loop
- `cargo test` — 15/15 unit tests pass, 0 failures

**New routes inventory (additions only)**:
```
GET    /api/v1/orgs/:org_id/resources
GET    /api/v1/orgs/:org_id/resources/:resource_id
PATCH  /api/v1/orgs/:org_id/resources/:resource_id/pool
PATCH  /api/v1/orgs/:org_id/resources/:resource_id/tags
DELETE /api/v1/orgs/:org_id/cis/:ci_id/associations/:assoc_id
DELETE /api/v1/orgs/:org_id/ci-types/:id
PATCH  /api/v1/orgs/:org_id/recommendations/checklist
POST   /api/v1/orgs/:org_id/recommendations/:id/reactivate
```

## Delta Note (2026-05-24, FinOps+CMDB loop x3, scope=both, focus=Aliyun)

### Loop 1 — Provider normalization gap closure
- Fixed provider mismatch in billing import flow by normalizing `aliyun` alias to canonical `alibaba`.
- Updated frontend provider sets to use `alibaba` (Cloud Accounts + CMDB create form), avoiding enum mismatch with `cloud_provider`.

### Loop 2 — Aliyun non-mock billing implementation
- Implemented signed Aliyun BSS OpenAPI client in `backend/src/modules/billing/aliyun_bss.rs`.
- Added `fetch_recent_line_items(credentials, config, days)` using `DescribeInstanceBill` with pagination, date filtering, and tolerant field parsing.
- Wired `POST /api/v1/orgs/:org_id/billing/import` non-mock branch to execute real Aliyun fetch + import instead of returning queued.
- Kept AWS non-mock billing path explicitly queued with clear message (no silent fallback).

### Loop 3 — Validation and hardening
- Added alias normalization unit tests in `backend/src/modules/billing/handlers.rs`.
- Added Aliyun product mapping tests in `backend/src/modules/billing/aliyun_bss.rs`.
- Validation run:
  - `cargo test --test billing_tests` → 7 passed, 0 failed.
  - `cargo check` → success (pre-existing warnings only).

### Quality gates
- Tenant isolation preserved (`ensure_org_member`, `organization_id`-scoped queries).
- No unsafe SQL string interpolation introduced.
- No secrets hardcoded; credentials still sourced from encrypted account payload.
