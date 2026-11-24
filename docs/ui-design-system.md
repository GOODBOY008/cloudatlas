# CloudAtlas UI/UX 设计规范与验收

更新于 2026-11-24。控制台直接使用 Cloudflare Kumo 组件库。CloudAtlas 的导航、工作区和业务操作由现有路由和表单管理。

## 视觉基准

控件采用 Kumo 发布包的实际实现与样式，页面框架参考 Cloudflare Dashboard 的全宽顶栏、工作区切换、分组侧栏和表格工具栏。[Kumo 组件库](https://github.com/cloudflare/kumo) · [Cloudflare Dashboard 官方界面](https://blog.cloudflare.com/new-application-security-experience/)

| 层级 | 实现 |
|---|---|
| 框架 | 56px 桌面顶栏、240px 侧栏、最大 1536px 的内容区，手机使用导航抽屉 |
| 输入 | Kumo `Input`、`InputArea` 和带图标的 `InputGroup`，表单名称、提示和校验关联到具体控件 |
| 选择 | `SelectField` 使用 Kumo `Select`，选项显式区分显示文字和值。弹窗通过 `KumoPortalProvider` 容纳选项列表 |
| 操作 | Kumo `Button` 和 `LinkButton`，创建与提交使用 primary，取消使用 secondary 或 ghost，删除使用 destructive 系列 |
| 列表 | Kumo `Table` 的 compact 表头和交替行底色，滚动区域继续使用 `table-scroll` |
| 标签 | `PageTabs` 使用 Kumo underline 标签和中英文溢出滚动按钮，日期筛选使用按下状态的分段按钮 |
| 主题 | Tailwind 4 编译 Kumo 的组件和主题。启动脚本和 React 同步 `data-mode` 与 `cloudatlas-theme`，图表使用共享的业务颜色 |
| 登录 | 公共页面使用品牌顶栏和居中表单，沿用控制台的输入框、主操作和主题切换 |

## 图表

10 个使用 Recharts 的模块统一采用 `lib/chartTheme.ts`：总览、费用、成本地图、成本对比、预算配额、资产统计、K8s 优化、异常检测、资源详情、成本池详情。模型拓扑也复用同一组主题颜色。

- 主序列蓝色，对比/预测橙色，其他序列使用协调的青、紫、绿、粉色；状态与厂商颜色保持含义。
- 线性折线、低透明度面积填充、细网格、无多余轴线；柱形限制宽度，避免少量数据形成巨大色块。
- 坐标轴使用紧凑数值，悬浮信息保留完整金额；统一 tooltip 的边框、背景与文字对比度。
- 禁用图表入场动画，让完整数据即时可见，也适配减少动态效果的偏好。
- 地图和拓扑使用 CSS 变量；树图文字在浅色填充和深色主题下均保持可读。

## 2026-11-17 逐页整理记录

全部 52 个产品路由都经过基础视觉检查。公共/流程页另查登录、重置密码、邀请、SSO 状态及 404。具体路由验收记录见下方矩阵；截图保存在 `output/playwright/ui-redesign/`。

改动包括每页页头、按钮、表格区域、标签页、指标与图表，不仅替换全局配色。额外修正了：成本地图手机摘要及图例挤压、模板页手机双栏、CI 树状态文字竖向换行、设置页标题位于标签下方、详情抽屉宽度，以及表格列宽压缩。

## 巡检发现的对象存储分析大响应

本地旧 API 在 1,578 个候选资源上返回 1,001,148 对关系，JSON 大小约 127.5 MB，导致浏览器无法完成页面加载。本轮做了必要的有界展示修复：

- 服务端 `matrix_limit` 默认 200、上限 1,000，返回相似度最高的关系；`matrix_meta` 明确总数、返回数量及是否截断。
- 分组、节省估算与汇总数量在裁剪之前计算，保持完整统计口径。现有相似度与分组算法未重写。
- 前端明确提示截断；相似矩阵和资源列表分页，大分组默认展开 20 个资源，可继续展开。
- 服务端全量配对计算仍为平方复杂度。本轮解决响应体与浏览器渲染边界，未重构分析引擎。

运行中的 Docker API 未替换。对这一页的浏览器验收，通过只读 QA 适配器把实际旧响应转换为新增有界响应契约；服务端实现另外运行 Rust 回归测试。其他页面复用实际 API 的只读响应，避免不同主题/尺寸重复触发本地请求限额。这个适配器只用于验收，不属于产品代码。

## 2026-11-17 验证与交付记录

- 前端 `npm run build` 通过；31 个单元测试文件、218 项测试全部通过。
- Rust 资源模块 3 项定向测试通过（含新增的排序/截断、默认值/上限回归）；`rustfmt --check` 与 `git diff --check` 通过。
- 全部 416 个路由视图没有渲染错误、加载残留、请求失败或横向溢出。另完成 26 个公共/流程页视图、30 次原生弹窗焦点检查、15 个手机弹窗内容边界检查，以及 8 个搜索/导航/抽屉/分页流程。
- 30 次弹窗检查验证的是背景页面不能接收焦点、Tab 返回对话框、Escape 关闭与焦点恢复；原生浏览器工具栏的正常键盘访问不算焦点逃逸。
- 视觉矩阵：中英文 × 深浅主题 × 1440px 桌面/390px 手机。每页检查渲染错误、加载状态、请求失败、横向溢出，并保存截图。
- 交互：模态框开关与焦点、详情抽屉、搜索、移动导航、分析标签、分页、主题切换。
- `dashboard-demo-*` 和 `expenses-*-demo*` 为浏览器内演示数据，用来检查有数据时的图表。未写入数据库，不能当作实际费用或生产数据。
- 变更保留在本地工作区；未提交、推送、部署、迁移数据库或触发云操作。

## Modern Web Guidance 的应用

- `css`：用共享语义变量和组件类保持主题一致，遵循 “Use CSS custom properties on `:root`”；避免各页再次复制颜色。
- `responsive-design`：外壳、抽屉和模态框使用动态视口单位，遵循 “Use dynamic viewport units”；筛选区基于内容容器适配。
- `responsive-table`：保留表头语义和横向滚动，为滚动区域添加名称及键盘入口，遵循 “Give the wrapper a `role="region"` attribute”。
- 手机 Copilot 使用原生 `showModal()` 管理焦点与遮罩。桌面悬浮窗使用 `show()`，允许继续操作页面，并让搜索和业务对话框显示在上层。

## 2026-11-17 路由验收矩阵

桌面与手机列均包含中英文、深浅主题四种组合。BI 导出的英文窄屏操作区问题已修正后复查。

| 页面 | 路由 | 桌面 | 手机 |
|---|---|---|---|
| 工作空间概览 | `/dashboard` | 通过 | 通过 |
| 数据链路 | `/data-flow` | 通过 | 通过 |
| 优化建议 | `/recommendations` | 通过 | 通过 |
| 优化建议检查清单 | `/checklist` | 通过 | 通过 |
| AI 中心 | `/ai-center` | 通过 | 通过 |
| 费用 | `/expenses` | 通过 | 通过 |
| 成本地图 | `/cost-map` | 通过 | 通过 |
| 成本分摊 | `/showback` | 通过 | 通过 |
| 预算与配额 | `/quotas-budgets` | 通过 | 通过 |
| 成本对比 | `/cost-comparison` | 通过 | 通过 |
| 对象存储 | `/object-storage` | 通过 | 通过 |
| BI 导出 | `/bi-export` | 通过 | 通过 |
| 资源 | `/resources` | 通过 | 通过 |
| 资源池 | `/pools` | 通过 | 通过 |
| 共享环境 | `/shared-environments` | 通过 | 通过 |
| 资源生命周期 | `/resource-lifecycle` | 通过 | 通过 |
| K8s 规格优化 | `/k8s-rightsizing` | 通过 | 通过 |
| 归档 | `/archive` | 通过 | 通过 |
| 配置项 | `/cmdb` | 通过 | 通过 |
| 服务 | `/services` | 通过 | 通过 |
| 动态分组 | `/dynamic-groups` | 通过 | 通过 |
| CI 类型管理 | `/ci-types` | 通过 | 通过 |
| CI 分类 | `/ci-classifications` | 通过 | 通过 |
| 关联类型 | `/association-kinds` | 通过 | 通过 |
| 模型拓扑 | `/model-topology` | 通过 | 通过 |
| 服务模板 | `/service-templates` | 通过 | 通过 |
| CI 拓扑 | `/ci-topology` | 通过 | 通过 |
| 字段模板 | `/field-templates` | 通过 | 通过 |
| 批量导入 CI | `/ci-import` | 通过 | 通过 |
| 资产统计 | `/cmdb-stats` | 通过 | 通过 |
| 外部 CMDB 与发现 | `/external-cmdb` | 通过 | 通过 |
| 合规 | `/compliance` | 通过 | 通过 |
| 标签覆盖率 | `/tagging-coverage` | 通过 | 通过 |
| 标签策略 | `/tagging-policies` | 通过 | 通过 |
| 组织约束 | `/constraints` | 通过 | 通过 |
| 漂移检测 | `/drift` | 通过 | 通过 |
| 异常检测 | `/anomaly-detection` | 通过 | 通过 |
| 电源计划 | `/schedules` | 通过 | 通过 |
| CI 应用规则 | `/ci-apply-rules` | 通过 | 通过 |
| 云账号 | `/cloud-accounts` | 通过 | 通过 |
| 账单导入 | `/billing-import` | 通过 | 通过 |
| 成本中心 | `/cost-centers` | 通过 | 通过 |
| 告警 | `/alerts` | 通过 | 通过 |
| 告警事件 | `/alert-events` | 通过 | 通过 |
| 事件 | `/events` | 通过 | 通过 |
| Webhook | `/webhooks` | 通过 | 通过 |
| 集成 | `/integrations` | 通过 | 通过 |
| 分配规则 | `/rules` | 通过 | 通过 |
| 设置 | `/settings` | 通过 | 通过 |
| 帮助中心 | `/help` | 通过 | 通过 |
| CMDB 审计日志 | `/cmdb-audit` | 通过 | 通过 |
| 优化建议 | `/recommendations/archived` | 通过 | 通过 |
