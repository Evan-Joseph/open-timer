# 11408 沉浸时钟 · API 文档（供各科 Agent / 自动化读取学习数据）

Base URL：`https://clock.4c666.top`
契约版本：v1（OpenAPI 3.1 见 `docs/openapi.yaml`）

## 认证模型

- **只读端点：完全公开，无需任何凭据。** 其他 Agent 直接 `GET` 即可拉取学习数据（科目、会话、时长、备注），也支持跨域（`Access-Control-Allow-Origin: *`），浏览器端脚本可直接 fetch。
- **写操作：必须登录。** 调用 `POST /api/v1/auth/login`（6 位 PIN）换取 `clock_session` cookie，之后所有写请求携带该 cookie（`fetch` 用 `credentials: 'same-origin'` / `curl -b cookies.txt`）。未登录写操作一律 `401 UNAUTHORIZED`。
- ⚠️ **公开只读意味着公网上任何人可读该数据**：学习时长/科目/备注不是机密，但请勿在备注中写入敏感信息。
- 时间口径：所有存储为 UTC；日期参数与汇总一律按 **Asia/Shanghai（固定 UTC+8）**。客户端不要自行换算。
- 幂等性：所有**会话写操作**（start / pause / resume / stop / switch / void / note / retime / adjust-start）要求请求头 `Idempotency-Key`（8–64 字符，客户端生成 UUID）。服务端按「端点:键」保存响应 24h；同键重试不产生重复副作用，回放**原状态码与原响应体**，并返回 `Idempotent-Replay: true`；缺键返回 400 `IDEMPOTENCY_KEY_REQUIRED`。auth/credentials 端点（setup/login/logout、凭据创建与撤销）是连接与凭据管理，不要求幂等键，由限流保护。
- 缓存：`daily-summary` 支持 `If-None-Match` + ETag，数据未变返回 `304`，避免重复拉取。

## 只读端点（公开）

### 1. `GET /api/v1/health`

```json
{ "status": "ok", "server_time": "2026-08-10T12:00:00.000Z", "version": "0.1.0" }
```

### 2. `GET /api/v1/subjects`

7 科目固定表（机器 ID + 显示名 + 聚合组）：

```json
[
  { "subject_id": "math", "display_name": "数学二", "aggregate_group": "math", "color_id": "amber", "sort_order": 1 },
  { "subject_id": "english", "display_name": "英语二", "aggregate_group": "english", "color_id": "teal", "sort_order": 2 },
  { "subject_id": "data-structures", "display_name": "数据结构", "aggregate_group": "408", "color_id": "blue", "sort_order": 3 },
  { "subject_id": "computer-organization", "display_name": "计算机组成原理", "aggregate_group": "408", "color_id": "indigo", "sort_order": 4 },
  { "subject_id": "operating-systems", "display_name": "操作系统", "aggregate_group": "408", "color_id": "violet", "sort_order": 5 },
  { "subject_id": "computer-networks", "display_name": "计算机网络", "aggregate_group": "408", "color_id": "cyan", "sort_order": 6 },
  { "subject_id": "politics", "display_name": "思想政治理论", "aggregate_group": "politics", "color_id": "coral", "sort_order": 7 }
]
```

### 3. `GET /api/v1/state`

当前实时状态：是否在计时、今日累计、当前开放段本段秒数（Agent 可轮询判断"此刻是否在学习"）。

```json
{
  "server_now_ms": 1786500000000,
  "server_now_iso": "2026-08-10T14:30:00.000Z",
  "active_session": {
    "session_id": "01KZ…",
    "subject_id": "math",
    "started_at": "2026-08-10T14:00:00.000Z",
    "status": "running",
    "active_seconds": 1800,
    "current_segment_started_at": "2026-08-10T14:00:00.000Z",
    "current_segment_active_seconds": 1800,
    "paused_at": null,
    "intent_note": "高数第 1 讲"
  },
  "today_active_seconds": 5400,
  "today_date": "2026-08-10"
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `active_session` | `null` = 当前没在计时；`status` = `running`/`paused` |
| `active_seconds` | 该会话累计净秒数（不含暂停离开时间） |
| `current_segment_started_at` | 当前开放段开始时刻（paused 时为 null） |
| `current_segment_active_seconds` | 本段已计秒数：running 时持续增长，paused 时冻结为末段净秒；可用于"最近一段学了多久" |
| `paused_at` | 暂停（离开）开始时刻，paused 时存在 |
| `today_active_seconds` | 今日（Asia/Shanghai）累计净秒数 |

### 4. `GET /api/v1/daily-summary?date=YYYY-MM-DD&timezone=Asia%2FShanghai` ⭐ 每晚 22:30 复盘用

`timezone` 只接受 `Asia/Shanghai`，其他值返回 400。

```json
{
  "date": "2026-08-10",
  "timezone": "Asia/Shanghai",
  "revision": 42,
  "generated_at": "2026-08-10T14:30:00.000Z",
  "total_active_seconds": 7320,
  "by_subject": [
    { "subject_id": "math", "display_name": "数学二", "active_seconds": 3600, "session_count": 1 },
    { "subject_id": "english", "display_name": "英语二", "active_seconds": 3720, "session_count": 2 },
    { "subject_id": "data-structures", "display_name": "数据结构", "active_seconds": 0, "session_count": 0 },
    { "subject_id": "computer-organization", "display_name": "计算机组成原理", "active_seconds": 0, "session_count": 0 },
    { "subject_id": "operating-systems", "display_name": "操作系统", "active_seconds": 0, "session_count": 0 },
    { "subject_id": "computer-networks", "display_name": "计算机网络", "active_seconds": 0, "session_count": 0 },
    { "subject_id": "politics", "display_name": "思想政治理论", "active_seconds": 0, "session_count": 0 }
  ],
  "aggregates": [
    { "group": "math", "active_seconds": 3600 },
    { "group": "english", "active_seconds": 3720 },
    { "group": "408", "active_seconds": 0 },
    { "group": "politics", "active_seconds": 0 }
  ],
  "sessions": [
    {
      "session_id": "01KZ…",
      "subject_id": "math",
      "started_at": "2026-08-10T00:10:00.000Z",
      "ended_at": "2026-08-10T01:10:00.000Z",
      "active_seconds": 3600,
      "status": "stopped",
      "end_reason": "manual",
      "note": "高数第 1 讲"
    }
  ],
  "running_session": null,
  "adjustments_or_revocations": [
    { "session_id": "01KZ…", "kind": "void", "reason": "误记", "at": "2026-08-10T03:00:00.000Z" }
  ]
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `revision` | 审计日志序号快照（覆盖所有写操作，含 note/retime/adjust-start）；同 date/revision 响应字节级确定，可作缓存键 |
| `by_subject[].active_seconds` | 该科目当日净学习秒数（已按 Asia/Shanghai 日窗裁剪） |
| `aggregates` | math / english / **408（四模块之和）** / politics |
| `sessions[].status` | `stopped`=正常结束。`voided` 会话被**完全排除**，不会出现在 `sessions` 数组与任何汇总中，仅通过 `adjustments_or_revocations` 可见 |
| `sessions[].active_seconds` | 该会话在**当日窗口内**的净秒数（跨午夜会话两侧分别入账） |
| `running_session` | 存在时表示当前正在计时，`active_seconds` 为截至 `generated_at` 的暂算值 |
| `adjustments_or_revocations` | 审计摘要：仅收录**会话开始于查询日窗口内**的撤回/改时条目（跨日会话的次日修正不出现在任一日，引用时以 events.jsonl 为全量依据）。`kind` 取值 `void`/`retime`/`note`；**起点补录（adjust-start）同样落 `kind='retime'`**（schema 约束），区分依据是审计日志 action（`retime` vs `session_start_adjust`）与 `before_json` 形态（`active_seconds` vs `started_at_ms`） |

### 5. `GET /api/v1/sessions?date=YYYY-MM-DD`

当日会话 + 段明细（含每个 segment 的起止，供时间轴类消费）：

```json
{
  "date": "2026-08-10",
  "timezone": "Asia/Shanghai",
  "sessions": [
    {
      "session_id": "01KZ…",
      "subject_id": "math",
      "started_at": "2026-08-10T00:10:00.000Z",
      "ended_at": "2026-08-10T01:10:00.000Z",
      "active_seconds": 3600,
      "status": "stopped",
      "end_reason": "manual",
      "note": "高数第 1 讲",
      "segments": [
        { "started_at": "2026-08-10T00:10:00.000Z", "ended_at": "2026-08-10T00:40:00.000Z" },
        { "started_at": "2026-08-10T00:45:00.000Z", "ended_at": "2026-08-10T01:10:00.000Z" }
      ]
    }
  ]
}
```

`segments` 中 `ended_at: null` 表示该段仍在进行（仅当前会话最后一段可能出现）。

## 写操作端点（需登录 cookie）

登录：`POST /api/v1/auth/login`，body `{ "password": "<本机安全配置中的 PIN>" }`。成功返回 `{ "ok": true }` 并设置 `clock_session` cookie。PIN 不得写入文档、仓库、命令历史或聊天。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/sessions` | 开始计时，body `{ "subject_id": "math", "intent_note": "可选" }`；返回 201 新会话 |
| POST | `/api/v1/sessions/:id/pause` | 暂停（离开）；本段结算，暂停时间不计入 |
| POST | `/api/v1/sessions/:id/resume` | 继续；开启新段，本段从 0 累计。**误触保护**：`stopped` 会话也可 resume（重开会话、清结束时刻，原段与秒数保留）；已有其他活动会话时 409 `ACTIVE_SESSION_EXISTS` |
| POST | `/api/v1/sessions/:id/stop` | 结束并保存，body `{ "end_note": "可选" }` |
| POST | `/api/v1/sessions/:id/switch` | 换科目：结束当前段并开启同会话新科目段，body `{ "subject_id": "..." }` |
| POST | `/api/v1/sessions/:id/void` | 撤回（误记），body `{ "reason": "可选" }` |
| PATCH | `/api/v1/sessions/:id/note` | 更新备注，body `{ "note": "..." }`（≤200 字） |
| POST | `/api/v1/sessions/:id/retime` | 修正时长：delta 落到末段结束时刻（而非仅改快照），汇总按段重算即反映；审计留痕。body `{ "delta_seconds": -300, "reason": "文字或 null" }`（±24h 内；reason 键必须存在，可为 null）；使末段时长为负时 400 `INVALID_RETIME` |
| POST | `/api/v1/sessions/:id/adjust-start` | 起点补录：把已停止会话的开始时间向前调整（同步首段与净时长），body `{ "started_at": "ISO8601", "reason": "文字或 null" }`；必须早于首段结束时刻，否则 400 `INVALID_START` |
| POST | `/api/v1/auth/logout` | 登出 |

上表会话写操作都需携带 `Idempotency-Key` 头（示例：`curl -H "Idempotency-Key: $(uuidgen)"`）。auth 与 credentials 端点不要求该头。

## 错误码

| 状态码 | error | 含义 |
|---|---|---|
| 400 | `INVALID_BODY` / `INVALID_DATE` / `INVALID_ID` / `TIMEZONE_MUST_BE_ASIA_SHANGHAI` / `IDEMPOTENCY_KEY_REQUIRED` / `INVALID_START` / `INVALID_RETIME` | 参数不合法或缺幂等键；起点补录时刻无效；retime 使末段时长为负 |
| 401 | `UNAUTHORIZED` / `INVALID_CREDENTIALS` | 未登录 / 密码错误 |
| 403 | `CSRF_REJECTED` | 写请求 Origin 与 Host 不同源 |
| 404 | `SESSION_NOT_FOUND` / `NOT_FOUND` | 会话不存在 / 未知路径 |
| 409 | `ACTIVE_SESSION_EXISTS` / `ILLEGAL_TRANSITION` / `ALREADY_SETUP` / `NOT_SETUP` / `NOT_ACTIVE_SESSION` | 状态冲突 |
| 429 | `RATE_LIMITED` | 登录或 API 请求过频 |
| 500 | `INTERNAL` | 服务端内部错误（不泄漏栈与路径） |

错误响应体：`{ "error": "CODE" }`。

## 给各科 Agent 的使用约定

1. **只读**：本 API 只返回时长事实，不包含掌握/完成度/正确率——那些由 study-ledger 管理，请勿混用。
2. **拉取频率**：`daily-summary` 有 ETag，带 `If-None-Match` 重复请求无变化时是 304（零成本）；`state` 可每 30–60s 轮询一次判断是否在学。
3. **撤回语义**：`voided` 会话与 `adjustments_or_revocations` 表示用户更正过，引用时长时以 `by_subject`/`aggregates` 为准（已排除撤回项）。
4. **跨午夜**：以北京时间日期为准查询；跨日会话在两侧日期各出现一次，`active_seconds` 是窗口内部分。
5. **写操作安全**：登录 cookie 是敏感凭据，只放各 Agent 的本地凭据文件，不入仓库、不出现在聊天明文中；Agent 默认只读，不要替用户启动/停止计时。

## curl 示例

```bash
BASE="https://clock.4c666.top"
# 今天（北京时间）的日期
TODAY=$(TZ=Asia/Shanghai date +%F)

# curl 不自动继承 macOS 系统代理。若直连超时，先从当前代理软件或
# `scutil --proxy` 核验本机 HTTPS 代理，再仅在当前 shell 显式设置 HTTPS_PROXY。
# 不要把机器特定端口固化到仓库。

# 1) 当前是否在学 + 今日累计（公开，无需认证）
curl -s "$BASE/api/v1/state" | python3 -m json.tool

# 2) 今日汇总（公开）
curl -s "$BASE/api/v1/daily-summary?date=$TODAY&timezone=Asia%2FShanghai" | python3 -m json.tool

# 3) 带 ETag 缓存（304 = 无变化）
ETAG=$(curl -s -D- -o /dev/null "$BASE/api/v1/daily-summary?date=$TODAY&timezone=Asia%2FShanghai" \
  | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -H "If-None-Match: $ETAG" "$BASE/api/v1/daily-summary?date=$TODAY&timezone=Asia%2FShanghai" -o /dev/null -w '%{http_code}\n'

# 4) 某日会话+段明细（公开）
curl -s "$BASE/api/v1/sessions?date=$TODAY" | python3 -m json.tool

# 5) 写操作示例（登录后带 cookie；仅当 Agent 被授权替用户操作时）
test -n "$CLOCK_PIN" || { echo 'CLOCK_PIN 未从本机安全配置加载' >&2; exit 1; }
curl -s -c /tmp/clock-cj.txt -X POST "$BASE/api/v1/auth/login" -H 'content-type: application/json' \
  --data-binary "$(printf '{\"password\":\"%s\"}' "$CLOCK_PIN")"
curl -s -b /tmp/clock-cj.txt -X POST "$BASE/api/v1/sessions" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"subject_id":"math"}'
```
