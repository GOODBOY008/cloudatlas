# CloudAtlas 科普入门指南

> 从零理解 FinOps 与 CMDB，再到动手跑起来

---

## 目录

1. [云时代的两个大问题](#1-云时代的两个大问题)
2. [什么是 FinOps](#2-什么是-finops)
   - [FinOps 的诞生背景](#21-finops-的诞生背景)
   - [FinOps 的三大文化支柱](#22-finops-的三大文化支柱)
   - [FinOps 的核心实践](#23-finops-的核心实践)
3. [什么是 CMDB](#3-什么是-cmdb)
   - [CMDB 解决什么问题](#31-cmdb-解决什么问题)
   - [CI 与关联关系](#32-ci-与关联关系)
   - [CMDB 在现代云原生场景中的演进](#33-cmdb-在现代云原生场景中的演进)
4. [FinOps 与 CMDB 为什么要合并](#4-finops-与-cmdb-为什么要合并)
5. [CloudAtlas 是什么](#5-cloudatlas-是什么)
   - [设计理念](#51-设计理念)
   - [核心模块一览](#52-核心模块一览)
6. [Quick Start 动手教程](#6-quick-start-动手教程)
   - [Step 1 — 启动平台](#step-1--启动平台)
   - [Step 2 — 登录与初识界面](#step-2--登录与初识界面)
   - [Step 3 — 接入一个云账号](#step-3--接入一个云账号)
   - [Step 4 — 查看云支出](#step-4--查看云支出)
   - [Step 5 — 建立成本池](#step-5--建立成本池)
   - [Step 6 — 查看优化建议](#step-6--查看优化建议)
   - [Step 7 — 在 CMDB 里认识你的资产](#step-7--在-cmdb-里认识你的资产)
   - [Step 8 — 给资源建关联关系](#step-8--给资源建关联关系)
   - [Step 9 — 设置预算告警](#step-9--设置预算告警)
   - [Step 10 — 配置下班自动关机](#step-10--配置下班自动关机)
7. [下一步](#7-下一步)

---

## 1. 云时代的两个大问题

企业上云之后，普遍会遭遇两种截然不同但又深度相关的痛苦：

**第一个痛苦：钱花哪去了？**

> "这个月账单 $58,000，但我不知道哪个团队、哪个项目花了多少，也不知道有多少资源其实根本没人用。"

**第二个痛苦：资产在哪里？**

> "线上出了故障，我知道某台数据库挂了，但我不知道哪些服务依赖它、影响范围有多大，也不确定这台机器是谁负责的。"

这两个痛苦在传统数据中心时代就存在，只是上云之后被放大了——资源数量从几百台变成了几千个对象，弹性伸缩让资产清单每天都在变，多云架构让账单来自四面八方。

**FinOps** 解决第一个痛苦，**CMDB** 解决第二个痛苦，而 **CloudAtlas** 把这两件事合在一个平台里做。

---

## 2. 什么是 FinOps

### 2.1 FinOps 的诞生背景

FinOps = **Financial Operations**，是 2019 年前后由 [FinOps Foundation](https://www.finops.org) 正式提出并推广的一套实践方法论。

在此之前，云支出的管理模式大致经历了三个阶段：

```
阶段 1 — 无人管理（2010s 早期）
  开发者自由开资源，月底收到账单才知道花了多少
  → 结果：严重超支，大量僵尸资源

阶段 2 — 财务单独管（2010s 中期）
  财务部门拿到账单，但看不懂技术细节
  → 结果：能控制总额，但无法定位浪费根源

阶段 3 — FinOps 协作模式（2020s）
  工程、财务、业务三方共同参与云成本决策
  → 结果：可见性 + 可归因 + 持续优化
```

FinOps 的核心洞察是：**云成本不是 IT 部门的问题，也不是财务部门的问题，它是一个跨职能协作问题。**

### 2.2 FinOps 的三大文化支柱

FinOps Foundation 定义了三个必须同时满足的文化转变：

#### 1. 团队协作（Teams need to collaborate）

| 角色 | 传统职责 | FinOps 中的职责 |
|---|---|---|
| 工程师 | 构建和运维 | 同时关注资源的成本效率 |
| 财务 | 控制预算 | 理解云的弹性计费模型 |
| 产品/业务 | 决定功能 | 评估功能对云成本的影响 |

云支出决策的时间窗口极短——一个工程师午饭前启动的 GPU 集群，下午就可能产生几千美元费用。只有让工程师实时看到成本，才能让决策发生在对的地方。

#### 2. 每个人都为云支出负责（Everyone takes ownership）

> "You build it, you run it, **you pay for it.**"

每个团队、每个服务、每个环境都应该能看到自己产生的费用，并为之负责。这不是惩罚机制，而是可见性和自主权的结合。

#### 3. 成本报告驱动行动（Reports drive action）

数据只有转化为决策才有价值。FinOps 强调：

- 成本数据必须**及时**（理想情况下 T+1 天）
- 成本数据必须**可归因**（能追溯到具体团队/项目/资源）
- 每一条优化建议必须有**可执行的下一步**

### 2.3 FinOps 的核心实践

FinOps 方法论把实践分为三个循环阶段：

```
    ┌─────────────────────────────────────┐
    │                                     │
    ▼                                     │
  告知 (Inform)                           │
  · 给所有团队看到实时成本数据             │
  · 按团队/项目/环境分摊费用              │
  · 建立预算和告警                        │
    │                                     │
    ▼                                     │
  优化 (Optimize)                         │
  · 识别闲置/过度配置资源                 │
  · 使用预留实例/节省计划                 │
  · 自动关停非生产环境                   │
    │                                     │
    ▼                                     │
  运营 (Operate)                          │
  · 将成本目标纳入交付流程               │
  · 持续跟踪优化措施落地效果             │
  · 更新预算和团队分摊规则               │
    │                                     │
    └─────────────────────────────────────┘
                （持续循环）
```

在 CloudAtlas 中，这三个阶段对应：

| FinOps 阶段 | CloudAtlas 功能 |
|---|---|
| 告知 | 费用仪表盘、成本池、标签归因、Showback 报告 |
| 优化 | 优化建议引擎、Power Schedule、预算告警 |
| 运营 | Assignment Rules、Tagging Policies、合规策略 |

---

## 3. 什么是 CMDB

### 3.1 CMDB 解决什么问题

CMDB = **Configuration Management Database**，配置管理数据库。这个词来自 ITIL（IT 服务管理框架），它的核心使命只有一句话：

> **知道你有什么，它们之间是什么关系，谁在负责。**

想象一下没有 CMDB 的场景：

```
告警：数据库 db-prod-01 连接数耗尽

值班工程师需要回答：
  Q1: 哪些服务会受影响？
      → 翻 Confluence，找不到最新的架构图
  Q2: 这台 DB 挂载在哪台宿主机上？
      → 问了三个人才有人知道
  Q3: 它的备份机在哪？主从复制延迟多少？
      → 得登录云控制台手动查
  Q4: 应该通知哪个团队？
      → 不确定，群里广播一下

结果：故障持续 45 分钟，本可以 10 分钟恢复。
```

CMDB 本质上是一张**持续更新的基础设施拓扑图**，让上面的每个问题都有确定性的答案。

### 3.2 CI 与关联关系

CMDB 的两个核心概念：

**CI（Configuration Item，配置项）**

CI 是 CMDB 中任何可追踪的对象。它不局限于服务器，任何对业务运转有影响的实体都可以是 CI：

```
物理层   → 服务器、交换机、机房机柜
虚拟层   → 虚拟机、容器、VPC、安全组
平台层   → 数据库、消息队列、缓存集群
应用层   → 微服务、API 网关、前端应用
业务层   → 支付系统、用户中心、推荐引擎
```

每个 CI 有：
- **属性**（Attribute）：描述它是什么，如 instance_type、region、CPU 核数
- **生命周期状态**：active → maintenance → decommissioned → deleted
- **标签**（Tag）：用于归类和成本分摊
- **变更历史**：谁在什么时候改了什么

**关联关系（Association）**

关联关系描述 CI 之间的依赖和从属：

```
web-prod-01 (EC2)  ──[run_on]──►  subnet-abc (VPC Subnet)
web-prod-01 (EC2)  ──[use]──────►  vol-xyz (EBS Volume)
api-service        ──[connect_to]► db-prod-01 (RDS)
api-service        ──[deploy_on]►  k8s-cluster-prod
```

当你知道了这张关系图，任何一个 CI 出现故障，CloudAtlas 的**影响分析**功能就能立刻告诉你：沿着关联链，哪些上下游会受到牵连。

### 3.3 CMDB 在现代云原生场景中的演进

传统 CMDB 的最大问题是**数据过时**——人工录入的 Excel 表或 CMDB 系统，往往在第一天就开始腐烂，因为资源每天都在变。

现代 CMDB 解决这个问题的关键：

1. **自动发现**：从云 API 自动同步资源清单，不依赖人工录入
2. **元数据驱动**：CI 类型和属性是可配置的，不需要改数据库表结构就能扩展
3. **与成本联动**：每个 CI 关联其实际产生的费用，资产管理和成本管理不再割裂

CloudAtlas 的 CMDB 采用**三层关联模型**（关联种类 → 模型关联 → 实例关联），并加入了云账单联动，使每个 CI 既有拓扑视角，也有成本视角。

---

## 4. FinOps 与 CMDB 为什么要合并

传统上，FinOps 工具（如 AWS Cost Explorer、CloudHealth）和 CMDB 工具（如 ServiceNow CMDB）是完全分开的两套系统。这种分离带来了新的摩擦：

| 场景 | 割裂的痛苦 |
|---|---|
| 账单优化 | 看到"某个 EC2 实例花了 $800/月"，但不知道这台机器属于哪个团队、跑着什么服务 |
| 故障响应 | CMDB 里有拓扑关系，但不知道把这台机器关掉会节省多少钱 |
| 容量规划 | 财务要求削减 20% 云支出，但工程无法判断哪些资源是安全可以缩减的 |
| 合规审计 | 要证明所有生产数据库都打了 backup 标签，得从两个系统导出数据手动比对 |

**当 FinOps 数据和 CMDB 数据共享同一个资产 ID 时，所有这些摩擦都消失了：**

```
账单优化  →  找到高花费 CI  →  立刻看到它的拓扑归属和负责人  →  通知正确的团队
故障响应  →  CI 故障  →  立刻看到关联服务和月度费用  →  判断是否值得降级处理
容量规划  →  选出低使用率 CI  →  关联关系确认无上游依赖  →  安全停机
```

这正是 CloudAtlas 的核心价值主张：**一个平台，同时是 FinOps 仪表盘和 CMDB 资产台账。**

---

## 5. CloudAtlas 是什么

### 5.1 设计理念

CloudAtlas 是一个开源、自托管的统一平台，设计原则如下：

**简单优先**
- 单一 PostgreSQL 数据库，不依赖 Redis、Kafka、Elasticsearch
- `docker compose up` 一条命令启动全部服务
- 没有复杂的微服务编排

**性能可靠**
- Rust 后端（Axum + SQLx + tokio），生产级别的内存安全和并发性能
- PostgreSQL JSONB 存储灵活元数据，无需 MongoDB

**开箱即用**
- 内置 10 种 CI 类型和完整的示例数据
- 内置优化建议引擎，连接云账号后自动运行
- Swagger UI 完整 API 文档

### 5.2 核心模块一览

```
CloudAtlas
│
├── 身份与权限
│   ├── 用户注册/登录（JWT + Refresh Token）
│   ├── 组织（多租户隔离）
│   └── RBAC 角色权限（Owner/Admin/FinOps/CMDB Editor/Viewer）
│
├── FinOps 模块
│   ├── 云账号管理（AWS / 阿里云 / Mock）
│   ├── 费用管道（原始账单 → 日聚合费用）
│   ├── 成本池（层级成本中心）
│   ├── 预算告警
│   ├── Assignment Rules（资源自动归池）
│   ├── Showback（费用分摊报告）
│   ├── Cost Map（地图/树图/单元经济学/预算矩阵）
│   ├── 标签策略（Tag Policy）
│   └── 组织约束（异常检测 / 资源数量限制）
│
├── 优化建议引擎
│   ├── 闲置资源（VM / 磁盘 / IP / 负载均衡 / S3）
│   ├── 过度配置（Rightsizing）
│   ├── 存储优化（快照整理 / S3 智能分层）
│   └── 安全合规（公开 S3 / 宽松安全组 / 不活跃用户）
│
├── CMDB 模块
│   ├── CI 类型（元数据驱动，可自定义）
│   ├── CI 实例（资产清单）
│   ├── 三层关联关系（Association Kind → Object Assoc → Instance Assoc）
│   ├── 服务（CI 集合）
│   ├── 动态分组（实时过滤）
│   ├── 合规策略（基线漂移检测）
│   └── 审计日志（字段级变更历史）
│
└── 自动化
    ├── Power Schedule（定时开关机）
    ├── 后台调度（云同步 / 账单导入 / 告警检查）
    └── Webhook（事件驱动通知）
```

---

## 6. Quick Start 动手教程

下面我们一步步把 CloudAtlas 跑起来，体验完整的 FinOps + CMDB 工作流。

**前置条件：** 安装 Docker 24+ 和 Docker Compose v2。

---

### Step 1 — 启动平台

```bash
# 克隆仓库
git clone <repo-url>
cd cloudatlas

# 复制配置文件（开发环境直接用默认值即可）
cp .env.example .env

# 一键启动（PostgreSQL + 数据库迁移 + API + 前端）
docker compose up
```

等待约 30 秒，看到以下日志说明启动成功：

```
cloudatlas-api     | INFO  cloudatlas > listening on 0.0.0.0:8080
cloudatlas-front   | ready in 312ms
```

现在打开浏览器：

| 地址 | 说明 |
|---|---|
| `http://localhost:3000` | 前端界面 |
| `http://localhost:8080/swagger-ui/` | API 文档（可在线调试） |
| `http://localhost:8080/health` | 健康检查 |

---

### Step 2 — 登录与初识界面

打开 `http://localhost:3000`，使用内置演示账号登录：

```
邮箱：admin@acme.com
密码：Password123!
```

登录后你会看到 **Dashboard（仪表盘）**，这是整个平台的指挥中心：

```
┌─────────────────────────────────────────────────────┐
│  本月总支出          对比上月          优化建议数      │
│  $12,400            ↑ 8.3%           14 条           │
├────────────────────┬────────────────────────────────┤
│  每日费用趋势图     │  按云提供商分布                 │
│  （折线图）         │  AWS: 74%  Mock: 26%           │
├────────────────────┴────────────────────────────────┤
│  Top 10 高费用资源                                   │
│  web-prod-01  $840/月  EC2  us-east-1              │
│  db-primary   $650/月  RDS  us-east-1              │
│  ...                                                │
└─────────────────────────────────────────────────────┘
```

左侧导航栏的结构：

```
仪表盘
├── FinOps
│   ├── Expenses（费用明细）
│   ├── Pools（成本池）
│   ├── Cost Map（成本地图）
│   ├── Showback（费用分摊）
│   ├── Recommendations（优化建议）
│   └── Alerts（预算告警）
├── CMDB
│   ├── CMDB（资产清单）
│   ├── Services（服务）
│   ├── Dynamic Groups（动态分组）
│   └── Compliance（合规策略）
└── 自动化
    ├── Power Schedules（电源计划）
    └── Rules（分配规则）
```

---

### Step 3 — 接入一个云账号

> 没有真实云账号？没关系，我们用内置的 **Mock 提供商**，它会模拟真实的资源和账单数据。

1. 点击左侧导航 **Cloud Accounts**
2. 点击右上角 **Add Account**
3. 填写表单：

   ```
   名称：My First Account
   提供商：mock
   配置：
   {
     "account_id": "111122223333",
     "region": "us-east-1"
   }
   凭证：留空（mock 不需要真实凭证）
   ```

4. 点击 **Test Connection** — 应显示 `mock connection ok`
5. 点击 **Save**
6. 点击 **Sync Now** 触发第一次同步

同步完成后，CloudAtlas 会自动：
- 在 CMDB 中创建发现的资源（EC2、RDS、S3 等）
- 开始导入账单数据到费用管道

在账号卡片上可以看到同步状态从 `pending → running → completed`。

---

### Step 4 — 查看云支出

同步完成后，导航到 **Expenses（费用）**：

**费用明细页**

- 设置日期范围为本月
- 你会看到按天聚合的费用列表，每条记录包含：资源名称、云提供商、地域、费用金额
- 使用筛选器按 CI 类型、地域或标签过滤

**费用汇总**

```
本月总计：$12,400.50
├── AWS：$9,200.00（74%）
└── Mock：$3,200.50（26%）

按地域：
├── us-east-1：$8,100.00（65%）
├── eu-west-1：$2,800.00（23%）
└── ap-southeast-1：$1,500.50（12%）
```

**Cost Map（成本地图）**

点击左侧 **Cost Map**，探索四个视角：

- **世界地图**：气泡大小代表各地域的花费，直观看出资源在哪里
- **树图（Treemap）**：按云提供商 → 服务类型 → 资源逐层钻取
- **单元经济学**：每种资源类型的平均日成本、资源数量、总花费占比
- **预算矩阵**：每个成本池的预算执行情况一览

---

### Step 5 — 建立成本池

成本池让你把费用按团队或项目分配。

1. 导航到 **Pools**
2. 点击 **Create Pool**，建立根池结构：

   ```
   Acme Corp（根池，系统已创建）
   ├── Engineering
   │   ├── Backend Team
   │   └── Frontend Team
   └── Data Platform
   ```

3. 先创建 `Engineering` 池（Parent 选 Acme Corp）
4. 再创建 `Backend Team`（Parent 选 Engineering）

**让资源自动归池（Assignment Rules）**

与其手动拖拽资源，不如设置规则让它自动归类：

1. 导航到 **Rules**
2. 点击 **Create Rule**
3. 设置条件和目标：

   ```
   规则名称：Backend Team Resources
   条件：标签 team = backend
   目标池：Backend Team
   优先级：10
   ```

4. 保存后，所有打了 `team=backend` 标签的资源会自动归入 Backend Team 池。

---

### Step 6 — 查看优化建议

导航到 **Recommendations**（优化建议）：

你会看到引擎自动发现的优化机会，例如：

| 建议类型 | 资源 | 可节省 |
|---|---|---|
| 闲置 EC2 实例 | web-dev-03 | $120/月 |
| 未挂载磁盘 | vol-unused-01 | $45/月 |
| 未关联弹性 IP | eip-legacy-02 | $7/月 |
| 实例规格降级 | analytics-01 (t3.xlarge→t3.medium) | $80/月 |

点击任意一条建议，查看详情：
- 判断依据（CPU 利用率、网络流量、访问记录等）
- 建议的具体操作步骤
- 预估节省金额

**处理建议的三种方式：**

```
Apply（标记已处理）
  → 表示你已经在云控制台完成了操作
  → 建议状态变为 applied，最终归档

Dismiss（忽略）
  → 填写原因（如"这台机器是预留的热备"）
  → 建议状态变为 dismissed

Snooze（暂缓）
  → 设置 N 天后再提醒
  → 建议暂时退出列表，到期后重新出现
```

---

### Step 7 — 在 CMDB 里认识你的资产

导航到 **CMDB**：

**CI 列表**

同步完成后，你会看到云账号中发现的所有资源已经作为 CI 出现在列表中，例如：

```
名称           CI 类型         地域          状态      标签
web-prod-01    ec2_instance    us-east-1     active    env=prod, team=backend
db-primary     rds_instance    us-east-1     active    env=prod, team=backend
app-bucket     s3_bucket       us-east-1     active    env=prod
vol-data-01    ebs_volume      us-east-1     active    env=prod
```

**查看 CI 详情**

点击 `web-prod-01`，在右侧抽屉中你会看到：

1. **基本信息**：CI 类型、云账号、地域、生命周期状态
2. **自定义属性**：CPU 核数、内存、操作系统、实例规格
3. **标签**：所有 key-value 标签
4. **费用**：这台机器本月产生的费用（来自账单联动）
5. **关联关系**：它依赖什么、什么依赖它
6. **变更历史**：这台机器的所有历史变更记录

**理解 CI 生命周期**

每个 CI 都有生命周期状态，支持手动流转：

```
active ──────────────→ maintenance（维护中）
  │                          │
  └──────→ inactive ←────────┘
               │
               └──→ decommissioned ──→ deleted
```

在 CI 详情页点击生命周期状态标签可以触发流转，系统会记录变更原因和操作人。

---

### Step 8 — 给资源建关联关系

让我们把 `web-prod-01`（EC2）和 `db-primary`（RDS）关联起来，表达"web 服务连接到数据库"的关系。

1. 打开 `web-prod-01` 的 CI 详情
2. 在 **Associations** 区域点击 **+ Link CI**
3. 填写：
   ```
   关联类型：connect_to（连接到）
   目标 CI：db-primary
   ```
4. 保存

现在点击 **Impact Analysis（影响分析）**，你会看到从 `web-prod-01` 出发的依赖链——如果这台机器出问题，影响范围一目了然。

**创建一个服务**

把相关 CI 组合成一个逻辑服务：

1. 导航到 **Services**
2. 点击 **New Service**，命名为 `Web Application`
3. 搜索并添加 `web-prod-01`、`db-primary`、`app-bucket` 到服务
4. 保存

服务详情页会显示：
- 所有成员 CI 及其状态
- 该服务的月度总费用（各 CI 费用汇总）

---

### Step 9 — 设置预算告警

不要等月底才发现超支，提前设置预算保护：

1. 导航到 **Pools**，打开 `Backend Team` 池
2. 点击 **Add Budget**
3. 配置：
   ```
   月度预算上限：$5,000
   告警阈值 1：80%（即 $4,000 时告警）
   告警阈值 2：100%（即 $5,000 时告警）
   通知方式：Webhook / Email
   ```
4. 保存

当 Backend Team 的月度费用达到 $4,000 时，CloudAtlas 会：
- 在 **Alerts** 页面创建告警事件
- 通过 Webhook 推送通知到你配置的 Slack/PagerDuty

**配置 Webhook（可选）**

1. 导航到 **Settings → Webhooks**
2. 点击 **Add Webhook**
3. 填写接收地址（如 Slack Incoming Webhook URL）
4. 选择订阅事件：`alert.triggered`、`recommendation.created`
5. 点击 **Send Test** 验证

---

### Step 10 — 配置下班自动关机

开发环境不需要 24 小时运行，设置 Power Schedule 可以节省约 60% 的费用：

1. 导航到 **Power Schedules**
2. 点击 **New Schedule**
3. 配置：
   ```
   名称：Dev Env — Business Hours
   时区：Asia/Shanghai
   启动时间：09:00
   关停时间：19:00
   工作日：周一 到 周五
   ```
4. 添加目标资源：
   - 按标签筛选 `env=dev` 的所有 EC2 实例
5. 启用并保存

CloudAtlas 每 5 分钟检查一次计划，在配置的时间点通过云 API 发送启动/停止指令。

---

## 7. 下一步

完成以上 10 个步骤后，你已经体验了 CloudAtlas 的核心工作流。接下来可以探索：

| 功能 | 入口 | 说明 |
|---|---|---|
| 动态分组 | CMDB → Dynamic Groups | 用条件表达式自动圈定资源集合 |
| 合规策略 | CMDB → Compliance | 检测 CI 是否偏离预期状态 |
| Tagging Coverage | Tagging Coverage | 找出哪些资源缺少必要标签 |
| 标签强制策略 | Settings → Tagging Policies | 定义哪些标签是所有资源必须有的 |
| Showback 报告 | Showback | 生成费用分摊报告交给财务 |
| API 集成 | http://localhost:8080/swagger-ui/ | 将 CloudAtlas 数据集成到内部系统 |
| 接入真实 AWS 账号 | Cloud Accounts → Add Account | 将提供商切换为 `aws`，填写真实凭证 |

**推荐阅读：**

- [完整用户手册](user-guide.md) — 所有功能的详细说明
- [API 示例](api-examples.md) — curl 命令速查
- [技术设计文档](design.md) — 架构和数据库设计细节
- [生产部署检查清单](production-checklist.md) — 上生产前必读

---

*CloudAtlas 是开源项目，欢迎提交 Issue 和 Pull Request。*
