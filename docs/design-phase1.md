# 11408 沉浸式学习时钟 · 第一阶段设计方案（研究 + 架构 + 交互）

日期：2026-08-09（北京时间）
状态：**草案，等待用户批准后才建立项目目录与编码**
工作区：`/Users/joseph/Desktop/【考研】11408考研备考`

---

## 1. 上下文接管与旧时间轴愿景摘要

### 1.1 已读取的当前事实（现场证据）

| 来源 | 结论 |
| --- | --- |
| 根 `AGENTS.md` / `CLAUDE.md` | 四科独立线程；禁止集中式工作台、共享日报、统一 API；真实作答/错因/闭卷提取/订正/间隔复习由 study-ledger 独占；本项目只记录时间执行数据。 |
| `README.md` | 「不存在集中式工作台、共享 daily/report、loopback 学习 API 或网页计时入口」——沉浸时钟是**新的独立计时产品**，不恢复旧工作台。 |
| `01_当前状态.md`（2026-08-09） | 集中式工作台已退役；数学一基础首轮（基础 30 讲高数第 1 讲，实体书印刷页 52/PDF 57 处）；408 从王道数据结构 1.1 起步；英语一待首个样本；政治 `planned_not_started`（最迟 2026-09-01）。 |
| `08_学习协作规则.md` | 计时是可选信息，不是掌握证据；不用 planned minutes 做停止线/惩罚；状态文件滚动摘要。 |
| `.study/summary.md` | study-ledger v2，当前事件为空；本项目不得写入任何学习事件。 |
| 各科 `00_学习状态.md` | 只读浏览确认科目模块现状；计时器的 7 科目模型与之兼容（数学一、英语一、数据结构、计组、OS、计网、政治）。 |
| `study-ledger due` | 输出 `[]`，无到期项。 |

### 1.2 旧工作台（已退役）的可复用思想与失败教训

旧工程 `【工具】11408学习工作台/` 已从工作树删除（git HEAD 仍存 1020 个文件，只读提取，不恢复）。关键结论：

**时间轴愿景（值得继承的部分）**
- `app/timeline.js` 已验证的日时间轴模型：固定 `PIXELS_PER_MINUTE=4`（24h = 5760px 宽轨道）、`MINIMUM_SEGMENT_WIDTH_PX=3` 保底宽度、30 分钟刻度、Asia/Shanghai 日切（`new Date('YYYY-MM-DDT00:00:00+08:00')`）、`Intl.DateTimeFormat(..., {timeZone:'Asia/Shanghai'})` 格式化、运行中会话以 now 截断。这套纯函数模型可直接重写借鉴。
- 时间轴片段按科目着色 + 最短可辨宽度 + hover 明细，是用户认可的形态。
- 计时条统一可见、不随任务卡漂移（"固定可见的统一计时条"）是 2026-07-28 用户明确指令，沉浸时钟沿用：全局唯一控件区。

**失败教训（明确不重复的部分）**
1. 旧工作台承载了计划发布、AI 助教、PDF、日报等太多角色，导致前端反复推倒重来（用户原话："你总是微调…直接把这一整套前端全部删掉重新开发"）。→ 沉浸时钟**只做计时 + 时间轴 + 只读汇总 API**，功能面冻结。
2. 多轮 Stitch 生成式 UI 迭代收敛极慢，"新版比多轮优化的旧版更差"。→ 本项目采用组件化手写实现 + 逐状态截图验收，不做生成式整页重绘。
3. 时间轴曾出现"重复片段、意义不明符号、聚焦当前时间的缩放"问题。→ 时间轴规则在 §7 写死：一天一条轨道、片段不重叠（互斥会话）、无装饰符号、当前时间用单条指示线、不做魔法缩放。
4. 逾期/攒任务造成压力。→ 本项目**完全没有计划、没有逾期概念**；激励只确认已记录的投入。
5. 曾探索 Cloudflare Workers/D1（旧 `cloudflare/`、`wrangler.jsonc`）但整体退役。→ 云平台能力本机有 wrangler 4.x 可用（已验证 `wrangler` 在 PATH），迁移路径真实可行，但第一阶段不创建云资源。

**能力边界声明**：本机 `~/.codex/sessions` 存有任务指定的各线程 rollout 存档，可只读检索；但按任务要求，本设计以本地文件与用户指令为唯一事实来源，未采信聊天内容作为需求依据。

### 1.3 与既有体系的边界（硬约束）

- 沉浸时钟 ≠ 学习账本。只记录：何时、哪个科目、计了多久、谁改了它。不记录作答、对错、覆盖、掌握。
- 总控（`019f9377-591e-74d1-a810-dc42a72c1766`）只通过只读 API 拿时长事实，每晚约 22:30 一次；总控离线不影响计时。
- 不修改四科仓库、`.study/`、study-ledger；不在根目录生成共享日计划/日报。

---

## 2. GitHub 候选项目比较表

核验方式：GitHub REST API（2026-08-09 现场查询）。★为星标，push 为最近推送日期。许可证以 API/license 文件为准。

### 2.1 时间追踪 / 状态机参考

| 项目 | ★ | 许可证 | 最近推送 | 结论 |
| --- | --- | --- | --- | --- |
| `super-productivity/super-productivity` | 21214 | MIT | 2026-08-08 | **重点参考**：MIT、极活跃。学习其 time tracking 的 start/stop/pause 交互、任务切换即结束上一段的处理、离线 localStorage + 恢复、空闲检测提示（idle detection 弹窗问用户"刚才是否在学习"——本项目的休眠唤醒恢复借鉴其交互）。不复制代码（Angular/Electron 栈不同）。 |
| `ActivityWatch/activitywatch`（aw-server 等） | 18535 | MPL-2.0 | 2026-08-06 | **模型参考**：event-based 时间轴、heartbeat 合并、bucket/事件可重放重建视图。MPL-2.0 允许文件级借用但不必要；只借鉴数据模型思想（原始事件→派生视图）。 |
| `kimai/kimai` | 4872 | AGPL-3.0 | 2026-08-06 | **只学概念**：running timer 单活动约束、timesheet 审计字段。AGPL-3.0 禁止复制任何代码；本项目单用户规模远小于 Kimai，不引入其 PHP 栈。 |
| `solidtime-io/solidtime` | 8846 | AGPL-3.0 | 2026-08-06 | 同上：参考其"活跃 timer 唯一"与周时间轴视觉；AGPL 不复制。 |
| `timetagger-app/timetagger` | 未核验（本次 API 限流未取到） | 待确认 | 待确认 | 记录为未知；不作为依据。 |

### 2.2 计时器/专注时钟

| 项目 | ★ | 许可证 | 最近推送 | 结论 |
| --- | --- | --- | --- | --- |
| `pqina/flip` | 1019 | MIT | 2026-07-13 | 翻页时钟视觉参考（数字翻牌）。沉浸时钟主时钟倾向**静态大数字 + tabular numerals**，翻页动效仅作为可关闭的备选，因此不直接依赖；列为视觉研究。 |
| `objectivehtml/FlipClock` | 2784 | MIT | 2025-09-09 | 老牌翻页钟，维护放缓，仅作视觉对照。 |
| `Diego-Ivan/Flowtime` | 133 | GPL-3.0 | 2025-04-28 | Flowtime 技法桌面 app；GPL-3.0 不复制。本项目**不实现 Flowtime/Pomodoro 节奏**（规则第九条：不强制比例、不自动暂停），仅确认"自由分段"是正确方向。 |
| `game-geek/flowmodor` | 0 | AGPL-3.0 | 2024-01 | 停止维护，排除。 |
| 其余搜索结果（OneTap-Time、FocusFlow 等） | ≤11 | 多为 None | — | 无许可证或体量过小，全部排除。 |

### 2.3 时间轴组件

| 项目 | ★ | 许可证 | 最近推送 | 结论 |
| --- | --- | --- | --- | --- |
| `visjs/vis-timeline` | 2538 | NOASSERTION（历史 Apache-2.0/MIT 双授权，API 标注待确认） | 2026-08-05 | 功能强大的通用甘特/时间轴，但体积大、视觉工业风、许可证标注需二次核验。**不采用**，自绘 SVG/div 时间轴（旧 `timeline.js` 模型证明几十行即可覆盖需求）。 |

### 2.4 前端基建（候选采用）

| 项目 | ★ | 许可证 | 最近推送 | 用途 |
| --- | --- | --- | --- | --- |
| `honojs/hono` | 31622 | MIT | 2026-08-09 | **推荐采用**：Web Standards 路由，同一套业务代码跑 Node（本地）与 Cloudflare Workers / CloudBase 云函数。 |
| `radix-ui/primitives` | 19149 | MIT | 2026-08-08 | **推荐采用**：Tooltip、Dialog、Switch、Tabs 的无样式可访问内核（键盘、focus trap、ARIA）。 |
| `shadcn-ui/ui` | 120888 | MIT | 2026-08-06 | 参考其 Radix + 设计 token 组合方式；按 shadcn 思路手写组件，不整体引入。 |
| `lucide-icons/lucide` | 23867 | ISC（license 文件现场核验） | 2026-08-08 | **推荐采用**：play/pause/square/flag/settings 等控件图标。 |
| `motiondivision/motion`（原 framer/motion） | 33164 | MIT | 2026-08-09 | **备选采用**：状态切换的空间过渡与结束反馈微动效；默认 prefers-reduced-motion 全关。 |
| `greensock/GSAP` | 27555 | 自定义 No-Charge 许可（非 OSI；2025 年 Webflow 收购后宣布永久免费含商用） | 2026-04-13 | 能力强但许可证非标准，且本项目动效量小。**V1 不用 GSAP**，用 CSS transitions + motion 足够；若未来需要复杂时间轴动画再评估。 |
| `drizzle-team/drizzle-orm` | 35402 | Apache-2.0 | 2026-08-07 | 评估后**暂缓**（见 §3.3）：单表模型 + 可移植性要求下，手写 repository + 显式 migration 更可控。 |

### 2.5 供应链风险结论

- 采用依赖仅 5 个核心：hono、radix primitives、lucide、react、vite 生态；全部 MIT/ISC、活跃维护、体积可控。
- 不整仓复制任何项目；AGPL/MPL 项目只作概念参考并在此明示。
- Apple HIG 参考官方文档（developer.apple.com/design/human-interface-guidelines，闭源规范，作为设计准则引用，无代码复制问题）。

---

## 3. 三条架构路线比较与推荐

### 3.1 路线 A：供应商中立 TypeScript 全栈（推荐）

```
┌────────────────────────────────────────────────────────┐
│ web/  React SPA（Vite 构建，静态产物）                   │
│   计时 UI · 时间轴 · 设置 · 登录                        │
└───────────────────────┬────────────────────────────────┘
                        │ /api/v1/*（JSON, 版本化, OpenAPI 契约）
┌───────────────────────▼────────────────────────────────┐
│ server/  Hono 应用                                      │
│   routes/    HTTP 层：校验、鉴权、限流、幂等             │
│   domain/    纯 TS：状态机、日切、汇总、审计（零依赖）    │
│   repo/      SessionRepository 接口                      │
│   adapters/  sqlite-adapter.ts │ d1-adapter.ts │ ...     │
└───────────────────────┬────────────────────────────────┘
                        │
        ┌───────────────┼───────────────────┐
   SQLite (本地)     D1 (Cloudflare)    CloudBase 数据库
```

- 领域层（状态机、Asia/Shanghai 日切、汇总、审计）是纯函数/纯 TS，可单测、可跑在 Node/Workers/CloudBase。
- 存储通过 repository 接口隔离；migration 用纯 SQL 文件 + 版本表，SQLite 与 D1 的 SQL 交集足够本项目使用。
- 优点：可迁移性最强，本地开发闭环最短，测试不依赖云。缺点：D1/CloudBase 适配器要自己写（工作量可控，表只有 ~7 张）。

### 3.2 路线 B：Cloudflare-first（Pages + Workers + D1 + Durable Objects）

- 优点：HTTPS/域名/备份/定时任务（Cron Triggers）开箱即用；DO 做单用户写锁很自然。
- 缺点：第一阶段就绑定 wrangler 开发回路与 D1 语义（无真实 WAL、事务限制）；本机调试需模拟云环境；用户尚未授权创建云资源。且本项目写并发极低（单人），DO 的价值主要是锁，可用数据库唯一索引替代。
- 结论：作为迁移目标保留，不作为第一版地基。

### 3.3 路线 C：CloudBase-first（静态托管 + 云函数 + 云数据库 + 登录）

- 优点：国内访问质量可能更好，云函数可跑 Node。
- 缺点：专有 SDK 侵入最深（登录、数据库触发器皆为专有语义）；免费额度/计费不透明需实测；与"业务逻辑不锁死专有 SDK"冲突最大。
- 结论：仅作为迁移清单保留（§9.4）。

### 3.4 推荐与关键取舍

**推荐路线 A。** 具体取舍：

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| HTTP 框架 | Hono（MIT） | 同一份 server 代码：本地 `@hono/node-server`，云上 Workers/CloudBase 云函数；路由中间件齐全。 |
| ORM | **不用 Drizzle/Prisma** | 表少、SQL 简单；手写 repository + 纯 SQL migration 在 SQLite→D1 迁移时方言风险最低；避免 ORM 生成的迁移文件绑定方言。 |
| 前端框架 | React 18 + Vite + TypeScript | 生态内计时/状态管理/测试工具最全；Radix + Lucide 无障碍现成。 |
| 状态管理 | 服务端状态为主（ETag 轮询 + 乐观 UI），前端仅一个轻量 store（Zustand 或自写 context） | 单页单用户，不需要重型方案。 |
| 时区库 | **不用 date-fns/luxon** | Asia/Shanghai 固定 UTC+8 无夏令时，日切用纯算术（`(utc_ms + 8h) / 86400000`）即可确定且可测；显示用 `Intl` + `timeZone:'Asia/Shanghai'`。 |
| 多标签页一致 | 服务端唯一 running 约束为权威；BroadcastChannel 同步 UI；可选 SSE | 不引入 WebSocket，最小方案（§4.3）。 |
| 实时通知 | V1 轮询（10s）+ ETag；V2 可加 SSE | 单人场景轮询成本可忽略，迁移任何云都不依赖长连接。 |

---

## 4. 计时状态机与并发/恢复设计

### 4.1 状态机（服务端权威）

```
                    ┌──────────────────────────────────────┐
                    │                                      │
  [idle] --start--> [running] --pause--> [paused] --resume─┘
                       │                    │
                       └────stop/switch─────┴--stop--> [stopped(已保存)]
                       │
  任意异常会话：void（作废，保留审计）
  换科目：当前会话强制 stop(end_reason='subject_switch') + 新会话 start
```

合法状态：`idle / running / paused / stopped`；事件类型：`session_created / paused / resumed / stopped / voided / subject_changed_after_stop(仅审计)`。

硬规则与实现手段：

| 规则 | 实现 |
| --- | --- |
| 同一用户最多一个 running | 部分唯一索引 `UNIQUE(user_id) WHERE status IN ('running','paused')`；冲突返回 409 并回传当前活动会话。 |
| 服务端时间是事实来源 | 所有事件 `server_time_ms` 由服务端时钟写入；客户端只发请求。净时长 = Σ(segment_end − segment_start)，全部来自服务端时间戳。 |
| 幂等 | 每个写请求带 `Idempotency-Key`（客户端 UUID）；服务端保存 24h 键→响应表，重复请求直接回放原响应。双击、重试天然安全。 |
| pause 不计时 | running 期间维护开放 segment；pause 关闭 segment；resume 开新 segment。 |
| 作废 | `void` 仅在 `stopped` 或异常短会话上执行，写入 `ManualAdjustment` + `SessionEvent`，时间轴以删除线/弱化样式显示，汇总排除。 |
| 修改科目/时间 | 不改历史 segment；修改以 `ManualAdjustment` 记录旧值/新值/理由，汇总按调整后口径计算，原始事件链完整可回放。 |
| 计时结束 ≠ 学习完成 | API 与 UI 文案只出现"已记录时长"，不出现完成/掌握字样。 |

### 4.2 客户端时钟策略（刷新/休眠/后台都不丢不重）

- 前端**永不自行累计秒数**。显示值 = `server_confirmed_active_seconds + (monotonic_now − last_sync_monotonic)`，其中 `monotonic_now` 用 `performance.now()`（单调、不受系统时间修改影响）。
- 每次任何 API 成功响应都带回 `server_now_ms` + 活动会话最新快照 → 重新校准，误差被钳制。
- 刷新/重开：挂载即 `GET /api/v1/state` 恢复；running 会话从服务端 segment 恢复，无缝续显。
- 系统休眠唤醒：`visibilitychange`/`focus` 触发立即 resync；由于净时长来自服务端时间戳差，休眠期间若未 pause，时间照记（符合"服务端是事实"），并在设置中提供"唤醒后自动暂停待确认"选项（默认开：唤醒发现间隔 >10 分钟时弹温和确认"刚才在继续学习吗？"，可选补 pause——交互借鉴 Super Productivity 的 idle 提示，不责备）。
- 后台节流：不依赖 `setInterval`；显示用 rAF + 单调时钟差，节流只影响刷新频率，不影响数值正确性。
- 客户端与服务端时钟偏差：前端不做任何减法依赖本地墙钟；偏差仅影响"下一次 resync 前的显示平滑"，被钳制在 ±2s 显示误差内并快速归零。

### 4.3 多标签页 / 多设备

- 权威在服务端：第二个标签页尝试 start 时收到 409 + 活动会话详情，UI 直接切入该会话的跟随视图（不产生并行会话）。
- 同源多标签：`BroadcastChannel('immersive-clock')` 广播"状态已变化"提示，各标签立即 resync；这是性能优化而非正确性依赖。
- 多设备冲突策略：后写者收到 409 即跟随当前活动会话；停止/暂停永远允许（同一会话全局生效）。不做设备踢下线。

### 4.4 跨北京时间 00:00

- 会话与 segment 不拆分存储；日报汇总与时间轴渲染时按 `[date 00:00+08:00, +24h)` 窗口裁剪 segment，两侧各自入账。
- 运行中会话的"今日累计"在 00:00 自然归零（窗口滑动），结束反馈页同时展示跨天的两段。

---

## 5. 数据模型、北京时间日切与汇总算法

### 5.1 实体（UTC 时间戳存储；全部表带 `created_at`）

```sql
-- migration 0001（示意，正式文件为纯 SQL + schema_migrations 版本表）

subject(id TEXT PK,            -- math|english|data-structures|computer-organization
        display_name TEXT,     -- |operating-systems|computer-networks|politics
        aggregate_group TEXT,  -- math|english|408|politics
        color_id TEXT, sort_order INTEGER)

session(id TEXT PK,            -- ulid
        user_id TEXT NOT NULL,
        subject_id TEXT NOT NULL REFERENCES subject(id),
        status TEXT NOT NULL,  -- running|paused|stopped|voided
        intent_note TEXT,      -- 开始前可选的一句话目标
        end_note TEXT,         -- 结束后可补的备注
        end_reason TEXT,       -- manual|subject_switch|void
        started_at_ms INTEGER NOT NULL,   -- 服务端 UTC epoch ms
        ended_at_ms INTEGER,
        active_seconds INTEGER,           -- 派生冗余，可由 segments 重建
        created_at_ms INTEGER NOT NULL)
CREATE UNIQUE INDEX one_active_session ON session(user_id)
  WHERE status IN ('running','paused');

active_segment(id INTEGER PK AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES session(id),
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER)               -- NULL = 当前开放段
CREATE INDEX seg_session ON active_segment(session_id);
CREATE UNIQUE INDEX one_open_segment ON active_segment(session_id)
  WHERE ended_at_ms IS NULL;

session_event(id INTEGER PK AUTOINCREMENT,   -- 只追加，重建一切的事实
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,   -- created|paused|resumed|stopped|voided
        idempotency_key TEXT UNIQUE,
        server_time_ms INTEGER NOT NULL,
        payload_json TEXT)

manual_adjustment(id INTEGER PK AUTOINCREMENT,
        session_id TEXT NOT NULL, kind TEXT NOT NULL,  -- reassign_subject|retime|void|note
        before_json TEXT, after_json TEXT, reason TEXT,
        created_at_ms INTEGER NOT NULL)

api_credential(id TEXT PK, name TEXT, scope TEXT,      -- read_only
        token_sha256 TEXT NOT NULL, revoked_at_ms INTEGER, created_at_ms INTEGER)

audit_log(id INTEGER PK AUTOINCREMENT, actor TEXT, action TEXT,
        target TEXT, detail_json TEXT, server_time_ms INTEGER)

idempotency_record(key TEXT PK, endpoint TEXT, response_json TEXT,
        created_at_ms INTEGER)     -- 24h 清理
```

- `User`：单用户，固定行（owner），密码 argon2id 哈希存于 `owner_credential` 表。
- `DailySummary` **不建表**：每次请求实时由 segments 计算（单人单日数据量 ~几十行，毫秒级）；同一 date 的响应确定性由数据保证，`revision` = 当日相关最大 `session_event.id`。事件即审计，不存在第二事实来源。

### 5.2 日切与汇总算法（纯函数，全部可单测）

```ts
// shanghaiDayRange(date: 'YYYY-MM-DD') => [startUtcMs, endUtcMs)
const OFFSET_MS = 8 * 3600 * 1000;
const start = Date.UTC(y, m-1, d) - OFFSET_MS;   // 固定 +8，无 DST
const end = start + 86400000;

// clipSegment(seg, [start,end)) → {start,max(seg.start,start)}, {end,min(seg.end,end)}，空则丢弃
// activeSecondsOn(date) = Σ clipped segment 秒数
// by_subject: 按 subject_id 分组；session_count = 该日有可见段的会话去重数
// aggregates.408 = data-structures + computer-organization + operating-systems + computer-networks
// running_session.active_seconds = 截至 generated_at(server_now) 的暂算值, status='running'
```

确定性：同 date + 同 revision（事件序号）→ 字节级相同 JSON（字段序固定、时间一律 UTC ISO 8601 + 秒数）。

### 5.3 科目固定表（V1 不提供增删 UI）

| id | 显示名 | 聚合组 | 颜色（色板见 §7.3） |
| --- | --- | --- | --- |
| math | 数学一 | math | 琥珀 |
| english | 英语一 | english | 青绿 |
| data-structures | 数据结构 | 408 | 蓝 |
| computer-organization | 计算机组成原理 | 408 | 靛蓝 |
| operating-systems | 操作系统 | 408 | 紫（少量） |
| computer-networks | 计算机网络 | 408 | 湖蓝 |
| politics | 思想政治理论 | politics | 珊瑚红 |

---

## 6. 总控只读 API（v1 草案 + OpenAPI 摘录）

### 6.1 端点清单

| 方法/路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /api/v1/health` | 无 | `{status:'ok', server_time, version}`；不暴露数据量/路径。 |
| `GET /api/v1/subjects` | 任一有效凭据 | 7 科目固定表。 |
| `GET /api/v1/state` | owner cookie | 当前活动会话快照（前端恢复用）。 |
| `POST /api/v1/sessions`（start）/ `POST /api/v1/sessions/:id/pause|resume|stop|void` / `PATCH /api/v1/sessions/:id/note` | owner cookie | 写路径；全部要求 `Idempotency-Key`。 |
| `GET /api/v1/sessions?date=YYYY-MM-DD` | 任一有效凭据 | 当日会话+segment 明细。 |
| `GET /api/v1/daily-summary?date=YYYY-MM-DD&timezone=Asia%2FShanghai` | 总控 token | 见 §6.2。`timezone` 仅接受 `Asia/Shanghai`，其余 400（口径服务端统一，杜绝客户端各猜各的）。 |
| `GET /api/v1/daily-summary` 支持 `If-None-Match` | — | ETag = `W/"<date>-<revision>"`；未变化返回 304。 |

### 6.2 daily-summary 响应形态

```json
{
  "date": "2026-08-09",
  "timezone": "Asia/Shanghai",
  "revision": 1741,
  "generated_at": "2026-08-09T14:30:00Z",
  "total_active_seconds": 14820,
  "by_subject": [
    {"subject_id": "math", "display_name": "数学一", "active_seconds": 7200, "session_count": 2},
    {"subject_id": "data-structures", "display_name": "数据结构", "active_seconds": 7620, "session_count": 1}
  ],
  "aggregates": [
    {"group": "math", "active_seconds": 7200},
    {"group": "english", "active_seconds": 0},
    {"group": "408", "active_seconds": 7620},
    {"group": "politics", "active_seconds": 0}
  ],
  "sessions": [
    {"session_id": "01J…", "subject_id": "math", "started_at": "2026-08-09T00:12:00Z",
     "ended_at": "2026-08-09T02:12:00Z", "active_seconds": 7200, "status": "stopped",
     "end_reason": "manual", "note": null}
  ],
  "running_session": null,
  "adjustments_or_revocations": [
    {"session_id": "01J…", "kind": "void", "reason": "误触开始", "at": "2026-08-09T03:00:00Z"}
  ]
}
```

### 6.3 OpenAPI 3.1 摘录（完整文件将随项目提供）

```yaml
openapi: 3.1.0
info: { title: 11408 Immersive Clock API, version: 1.0.0 }
servers: [{ url: /api/v1 }]
paths:
  /daily-summary:
    get:
      summary: 北京时间某日学习时长汇总（总控只读）
      parameters:
        - { name: date, in: query, required: true, schema: { type: string, pattern: '^\d{4}-\d{2}-\d{2}$' } }
        - { name: timezone, in: query, required: true, schema: { enum: [Asia/Shanghai] } }
      responses:
        '200': { description: 当日汇总, headers: { ETag: { schema: { type: string } } } }
        '304': { description: revision 未变化 }
        '400': { description: date 或 timezone 非法 }
        '401': { description: 凭据缺失或已撤销 }
components:
  securitySchemes:
    api-key: { type: apiKey, in: header, name: X-API-Key }
    owner-cookie: { type: apiKey, in: cookie, name: clock_session }
security: [{ api-key: [] }, { owner-cookie: [] }]
```

（schemas 段包含 `DailySummary`、`SubjectEntry`、`SessionEntry`、`AdjustmentEntry`，字段与 §6.2 一一对应。）

### 6.4 API 边界

- 总控 token：`scope=read_only`，仅可 GET subjects/sessions/daily-summary/health；任何写请求返回 403。token 只存 sha256，仓库只保留 `api_credential` 记录；轮换=新建一条+撤销旧条，即时生效。
- 响应只含时长事实；无掌握、完成度、评价字段。
- 总控挂掉 → 数据在服务端留存，恢复后带 date 重读即可（幂等只读）。

---

## 7. 界面信息架构、线框与视觉规范

### 7.1 单页三态 + 底部时间轴

```
┌───────────────────────────────────────────────────────┐
│ [沉浸时钟]                    2026-08-09 周日 20:41 ⌃设置│  ← 顶部材质条，44px
├───────────────────────────────────────────────────────┤
│                                                       │
│                  数据结构 · 运行中                     │  ← 科目胶囊（第一视觉）
│                    01:24:36                            │  ← 净时长，56-72px tabular
│              北京时间 20:41 · 今天累计 03:52            │  ← 次级信息
│                                                       │
│          ( ⏸ 暂停 )   ( ⏹ 结束 )                       │  ← 图标按钮 + tooltip
│                                                       │
├───────────────────────────────────────────────────────┤
│ 今日时间轴                                             │
│ 00    04    08    12    16    20   |21                │
│ ▓▓  ▓    ▓▓▓▓▓▓        ▓▓▓▓▓▓▓▓▓|░░░░░░░░░░░░        │
│ ■数学 ■英语 ■数据结构 ■计组 ■OS ■计网 ■政治             │  ← 图例（非颜色线索=图例文字）
└───────────────────────────────────────────────────────┘
```

- **空闲态**：大时钟（28-32px，次视觉）+ 日期星期；7 科目选择器（分两组：公共课 math/english/politics 一行，408 四模块一行，各带色点+文字）；最近科目排前但不自动开始；可选一句话目标（单行 input，placeholder"本次想做什么？（可选）"）；大号"开始"按钮；下方时间轴 + 各科今日小计。
- **运行态**：如上；标签页标题变 `▶ 01:24:36 · 数据结构`；favicon 加色点；不发系统通知（V1 默认关，设置内可开"结束时提醒"）。
- **暂停态**：数字冻结、科目胶囊降饱和、背景材质微调暗 4%，文案"已暂停"；按钮为 ( ▶ 继续 ) ( ⏹ 结束 )。不用红色、不用倒计时催促。
- **结束反馈**：非模态卡片在时钟区原位展开：本次科目/净时长/起止时间/今日累计；一行备注输入；温和确认文案"已记录 1 小时 24 分数据结构。今天共 3 小时 52 分。"；完成动效=1.2s 内的柔光扩散，可在设置关闭，`prefers-reduced-motion` 下自动关。
- **作废/修正入口**：结束卡片与"最近会话"列表里提供"标为误记"（需一句理由），走 void/adjustment 流程。

### 7.2 时间轴规格（重写旧 `timeline.js` 模型）

- 轨道：当日 00:00–24:00，4 px/min（5760px），容器 `overflow-x:auto`；自动滚动使当前时间线位于视口 60% 处（仅初次与切换日期时）。
- 片段：高度 20px；`min-width:3px`；相邻片段间距 1px；运行中片段右缘接当前指示线并以 70% 透明度延续。
- 当前指示线：1px、中性色、顶端小三角，无动画闪烁；每 30s 位移一次（足够）。
- 点击区域：片段自身 + 透明热区扩展到 ≥24px 宽（WCAG 2.5.8 target size）；`<button>` 实现，键盘 Tab 可聚焦，Enter 打开详情 popover（起止、净时长、科目、备注、作废标记）。
- 跨日会话：裁剪渲染；popover 注明"开始于前一日 23:40"。
- 作废会话：灰色斜纹、删除线 tooltip，不计入任何汇总。
- 刻度：整点大刻度 + 标签，半点小刻度；容器高度固定 96px，内容变化零布局跳动。
- 小屏（<560px）：时间轴切换为纵向"当日记录列表"（按时间排序的胶囊行），同一数据源。
- 日期切换：`← 今天 →`，最多回看 30 天（V1）。

### 7.3 视觉规范（Apple 风，生产工具气质）

- **层级与材质**：仅顶部栏与浮层使用 `backdrop-filter: blur(20px) saturate(1.8)` 材质；主体是纯色分层背景（浅 `#F5F5F7`/深 `#1C1C1E` 系）。
- **排版**：系统字体栈 `-apple-system, 'SF Pro Text', 'PingFang SC', ...`；计时数字 `font-variant-numeric: tabular-nums`；字级阶梯 13/15/17/22/28/56；不按视口缩放字号、不用负字距。
- **圆角**：卡片/按钮 ≤8px；胶囊仅用于科目选择器与图例（语义需要）。
- **颜色**：浅深两套语义 token（`--surface-1/2`、`--text-1/2`、`--accent`、7 个科目色各含浅深变体）；7 色相间隔排布避免蓝紫扎堆（琥珀/青绿/蓝/靛蓝/紫/湖蓝/珊瑚，均过 3:1 图形对比度；文字一律用 `--text-1`）。
- **状态**：所有控件定义 hover/press(active scale 0.98)/focus-visible(2px accent 环)/disabled/loading（骨架或 spinner）/error（文字+边框，不用纯红块）。
- **主题**：`light / dark / auto` 三态设置项；`auto` 跟随 `prefers-color-scheme` 且无闪白（内联脚本提前设 `<html data-theme>`）。
- **动效预算**：状态切换 200-300ms ease-out；结束反馈 ≤1.2s；全程尊重 `prefers-reduced-motion`（媒体查询命中时动效开关强制为关，布局功能不受影响）。
- **禁止清单**：渐变球、紫蓝大渐变、Hero、卡片套卡片、超大圆角、装饰插画、动画延迟操作、用动画隐藏真实状态。

---

## 8. 激励、提醒、声音与 reduced-motion 策略

| 机制 | 策略 |
| --- | --- |
| 结束反馈 | 只确认事实："已记录 X 分钟〈科目〉，今天共 Y"。无夸奖、无评判、无连续天数、无排行榜。 |
| 目标时长 | V1 不做；即使 V2 加入也仅显示参考线，不是停止线/债务，超时不改变任何文案。 |
| 提醒 | 仅两种且默认全关：① 暂停超过 2 小时且会话未结束时的温和系统通知"有个暂停中的会话，要继续还是结束？"；② 每日 23:30 可选"今天的时间轴已生成"。都在设置内一键关闭。 |
| 声音 | V1 无提示音；V2 若加入：默认静音、单次短音、跟随系统勿扰。 |
| 触觉 | Web 端不适用（Vibration API 仅 Android Chrome），不实现。 |
| reduced-motion | 全局 CSS：`@media (prefers-reduced-motion: reduce)` 下所有 transition/animation duration 归零；JS 动效（motion 库）同一开关；设置里另有"动画"总开关取两者与集。 |
| 空状态 | 空闲页"今天还没有记录——选一个科目开始第一段。"提供下一步，不出现"已经 N 天没学"类文案。 |
| 错误状态 | 网络失败=顶部细条"暂时无法同步，已保留你的操作，正在重试"，自动退避重试；不指责用户。 |

---

## 9. 公网安全、鉴权、备份与迁移方案

### 9.1 鉴权

- **Owner 登录**：设置初始化密码（≥12 位）；argon2id 哈希；登录后发 HttpOnly + Secure + SameSite=Lax cookie，7 天滑动过期；登出即失效。
- **总控凭据**：设置页生成 `clk_…` token（只读），显示一次；服务端存 sha256；支持新建/撤销（轮换）；每次调用记 audit_log（不含 token 本体）。
- 前后端权限分离：前端 bundle 不含任何 token；owner cookie 对 `/api/v1` 具写权限；总控 token 只有读。

### 9.2 攻防清单（V1 全部落地）

| 威胁 | 对策 |
| --- | --- |
| CSRF | SameSite=Lax cookie + 写请求校验 `Origin` 头匹配 + fetch 仅限同源；token 类请求不走 cookie。 |
| XSS | React 默认转义；`dangerouslySetInnerHTML` 禁用；CSP `default-src 'self'; style-src 'self' 'unsafe-inline'`（Vite 产物无外部脚本）。 |
| 点击劫持 | `X-Frame-Options: DENY` + `frame-ancestors 'none'`。 |
| 暴力破解 | 登录接口限流（5 次/分/IP，指数退避）；API 全局限流 300 次/分/token。 |
| 头泄漏 | 安全响应头：HSTS（公网后）、X-Content-Type-Options、Referrer-Policy: no-referrer、去 Server 版本号。 |
| 输入注入 | zod 在路由层校验一切入参（日期格式、枚举、长度≤200 字符）；SQL 全参数化。 |
| 日志 | 结构化日志只含：时间、路由、状态码、actor 名、session_id；不含 token、cookie、备注全文。 |
| 错误页 | 公网 4xx/5xx 统一 JSON/HTML 模板，不泄漏栈/路径/配置。 |
| HTTPS | 公网部署强制 301 + HSTS；本地 http://127.0.0.1 除外。 |

### 9.3 备份与恢复

- SQLite WAL 模式；每日 `sqlite3 .backup` → 带日期副本（本机脚本，部署后改云端定时任务）。
- 事件级可携带导出：`GET /api/v1/export/events.jsonl`（owner-only）输出全部 session_event/adjustment；任何新库可从该文件重放重建全部 session 与汇总——这是"事件是唯一事实"的兜底。
- migration 向前兼容策略：只加列不改义；破坏性变更必须新版本号 + 迁移脚本 + 导出先行。

### 9.4 迁移清单

| 能力点 | 本地 V1 | → Cloudflare | → CloudBase |
| --- | --- | --- | --- |
| 静态前端 | Vite dev/build + 本地静态服务 | Pages | 静态网站托管 |
| API 运行时 | `@hono/node-server` | Workers（同一 Hono 代码） | 云函数 Node 运行时（Hono 适配） |
| 存储 | better-sqlite3 文件 | D1（新 adapter，SQL 交集已验证） | CloudBase 数据库（MySQL 方言 adapter） |
| 定时备份 | 本机 launchd/cron 脚本 | Cron Triggers + R2 | 定时触发器 + COS |
| 鉴权 | cookie + argon2id（同代码） | 同左（Workers 支持 WebCrypto argon2 via @node-rs/argon2-wasm） | 同左 or CloudBase 自定义登录 |
| HTTPS/域名 | 无 | Cloudflare 托管域名 | 需备案域名（国内访问优势，成本与合规待用户决策） |
| 风险 | — | D1 无 WAL、单库 10GB 内；读多写少场景无压力 | 免费额度变化、SDK 专有性最高 |

迁移顺序预案：本地验收 → 用户选定云 → 建 adapter 与 migration 回放测试 → 用 events.jsonl 全量重放 → 双跑对账（同 date/revision 响应一致）→ 切换。**在用户明确授权前不创建任何云资源、域名、付费服务，不 push 任何仓库。**

---

## 10. V1/V2 边界、实施计划、测试计划与风险

### 10.1 V1 范围（本次实现）

- 7 科目计时全流程（start/pause/resume/stop/void/note）、幂等、刷新/休眠/多标签恢复；
- 单页三态 UI + 日时间轴（今天 + 回看 30 天）+ 浅深 auto 主题 + reduced-motion；
- owner 登录、总控只读 token、daily-summary/subjects/sessions/health、ETag；
- SQLite 持久化 + migration + events.jsonl 导出 + 每日备份脚本；
- 单元/集成/Playwright 测试与截图证据。

### 10.2 V2 候选（不在本次）

结束提示音、SSE 实时、周视图统计图表、可选目标参考线、PWA 离线壳、云端部署实施。

### 10.3 实施计划（批准后按序执行）

1. 建项目目录与独立 git 仓库；落 OpenAPI 契约与 domain 纯函数 + 单测先行。
2. 存储层（SQLite adapter + migration + repository 契约测试）。
3. Hono 路由 + 鉴权 + 幂等 + 限流；集成测试。
4. 前端三态 UI + 时间轴 + 主题；Playwright 逐视口截图验收。
5. 备份/导出脚本、安全头、文档（README + 总控接入说明）。

### 10.4 测试计划（对应任务十二条）

- **单测（vitest）**：状态机全转移表 + 非法转移；日切（含跨午夜、夏令时不存在性断言）；汇总与 408 聚合；幂等回放。
- **集成（vitest + 内存/临时 SQLite）**：API 全端点；双 token 权限；并发 start 只赢一个（UNIQUE 冲突路径）；重试不重写事件。
- **E2E（Playwright）**：375×812 / 768×1024 / 1024×768 / 1440×900 × 浅深主题 × reduced-motion 组合截图；计时数字独立校验（用 API 返回秒数与 UI 文本比对，不只看文本）；时间轴片段热区点击；无布局跳动（截图 diff 容器高度）。
- **手工场景清单**：快速双击开始；刷新/关闭重开；多标签各自 start；`pmset sleep`/合盖唤醒；网络断开 30s 恢复；跨 00:00 挂机；误触作废与科目修正审计。
- 交付证据：关键流程录像/截图、canvas/DOM 非空断言、无重叠断言、测试报告。

### 10.5 风险清单

| 风险 | 缓解 |
| --- | --- |
| 浏览器长后台 rAF 冻结导致显示滞后 | 单调时钟差 + resync 钳制；正确性不依赖显示。 |
| SQLite→D1 SQL 方言差异 | 只用交集语法；migration 纯 SQL 文件在两个 adapter 上回放测试。 |
| 单人项目过度设计 | V1 范围冻结（§10.1）；无队列、无 WebSocket、无 ORM。 |
| CloudBase 计费/免费额度未知 | 标记"待确认"；迁移前实测，默认优先 Cloudflare。 |
| 时间轴像素拥挤（凌晨密集段） | 热区扩展 + popover；必要时 V2 加局部放大。 |
| 主仓库有大量未提交删除 | 新项目独立 git 仓库，物理目录隔离，不 stage 任何主仓库改动。 |

---

## 11. 新项目路径与 Git 边界（待确认）

**建议路径**：`/Users/joseph/Desktop/【考研】11408考研备考/【工具】11408沉浸时钟/`
- 与旧 `【工具】11408学习工作台/` 命名对齐、边界清晰；内部结构：`web/ server/ shared/ migrations/ tests/ docs/ scripts/`。

**建议 Git 边界**：该目录 `git init` 为**独立仓库**。
- 理由：主仓库当前有 1027 项未提交改动（含旧工作台整体删除），新代码混入会把两件事耦合；独立仓库保证新项目提交历史干净、可整体迁移。
- 主仓库侧仅在批准后追加一行 `.gitignore`：`【工具】11408沉浸时钟/`（避免主仓库把它当未跟踪文件干扰）；不执行 reset/checkout/clean，不恢复任何旧文件。
- 本项目 V1 不 push 任何远端。

---

## 12. 待用户确认事项（批准门）

1. 是否批准 §11 的路径 + 独立 Git 仓库方案；
2. 是否批准路线 A 技术栈（React+Vite / Hono / SQLite→可替换 adapter / 无 ORM）；
3. 动效库：默认 CSS transitions + motion（MIT）替代 GSAP —— 是否同意；
4. V1 范围（§10.1）是否有增删；
5. 云平台倾向（Cloudflare 优先 / CloudBase 优先 / 暂不决定）——只影响迁移清单排序，不影响 V1。

批准后进入第二阶段：建立目录、落契约与代码。
