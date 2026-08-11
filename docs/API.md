# 11408 沉浸时钟 · API 文档（供各科 Agent / 总控拉取学习时长）

Base URL：`https://immersive-clock-11408.gaoshenzhou.workers.dev`
契约版本：v1（OpenAPI 3.1 见 `docs/openapi.yaml`）

## 认证

- **只读 token**：请求头 `X-API-Key: clk_…`。token 在网页「设置」中未暴露生成入口，当前由项目维护者生成；只可读取本文件列出的端点，任何写操作返回 401。
- 时间口径：所有存储为 UTC；日期参数与汇总一律按 **Asia/Shanghai（固定 UTC+8）**。客户端不要自行换算。
- 所有端点支持 `If-None-Match` + ETag：数据未变返回 `304`，避免重复拉取。

## 端点

### 1. `GET /api/v1/health`（无需认证）

```json
{ "status": "ok", "server_time": "2026-08-10T12:00:00.000Z", "version": "0.1.0" }
```

### 2. `GET /api/v1/subjects`

7 科目固定表（机器 ID + 显示名 + 聚合组）：

```json
[
  { "subject_id": "math", "display_name": "数学一", "aggregate_group": "math", "color_id": "amber", "sort_order": 1 },
  { "subject_id": "english", "display_name": "英语一", "aggregate_group": "english", "color_id": "teal", "sort_order": 2 },
  { "subject_id": "data-structures", "display_name": "数据结构", "aggregate_group": "408", "color_id": "blue", "sort_order": 3 },
  { "subject_id": "computer-organization", "display_name": "计算机组成原理", "aggregate_group": "408", "color_id": "indigo", "sort_order": 4 },
  { "subject_id": "operating-systems", "display_name": "操作系统", "aggregate_group": "408", "color_id": "violet", "sort_order": 5 },
  { "subject_id": "computer-networks", "display_name": "计算机网络", "aggregate_group": "408", "color_id": "cyan", "sort_order": 6 },
  { "subject_id": "politics", "display_name": "思想政治理论", "aggregate_group": "politics", "color_id": "coral", "sort_order": 7 }
]
```

### 3. `GET /api/v1/daily-summary?date=YYYY-MM-DD&timezone=Asia%2FShanghai` ⭐ 总控每晚 22:30 用

`timezone` 只接受 `Asia/Shanghai`，其他值返回 400。

```json
{
  "date": "2026-08-10",
  "timezone": "Asia/Shanghai",
  "revision": 42,
  "generated_at": "2026-08-10T14:30:00.000Z",
  "total_active_seconds": 7320,
  "by_subject": [
    { "subject_id": "math", "display_name": "数学一", "active_seconds": 3600, "session_count": 1 },
    { "subject_id": "english", "display_name": "英语一", "active_seconds": 3720, "session_count": 2 },
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
| `revision` | 事件序号快照；同 date/revision 响应字节级确定，可作缓存键 |
| `by_subject[].active_seconds` | 该科目当日净学习秒数（已按 Asia/Shanghai 日窗裁剪） |
| `aggregates` | math / english / **408（四模块之和）** / politics |
| `sessions[].status` | `stopped`=正常结束；`voided`=已撤回（不计入任何汇总） |
| `sessions[].active_seconds` | 该会话在**当日窗口内**的净秒数（跨午夜会话两侧分别入账） |
| `running_session` | 存在时表示当前正在计时，`active_seconds` 为截至 `generated_at` 的暂算值 |
| `adjustments_or_revocations` | 当日撤回/改时审计摘要 |

### 4. `GET /api/v1/sessions?date=YYYY-MM-DD`

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

## 给各科 Agent 的使用约定

1. **只读**：本 API 只返回时长事实，不包含掌握/完成度/正确率——那些由 study-ledger 管理，请勿混用。
2. **拉取频率**：daily-summary 有 ETag，带 `If-None-Match` 重复请求无变化时是 304（零成本）。
3. **撤回语义**：`voided` 会话与 `adjustments_or_revocations` 表示用户更正过，引用时长时以 `by_subject`/`aggregates` 为准（已排除撤回项）。
4. **跨午夜**：以北京时间日期为准查询；跨日会话在两侧日期各出现一次，`active_seconds` 是窗口内部分。
5. **token 保管**：token 只放各 Agent 的本地凭据文件，不入仓库、不出现在聊天明文中。

## curl 示例

```bash
TOKEN="clk_…"  # 只读 token
BASE="https://immersive-clock-11408.gaoshenzhou.workers.dev"

# 今日汇总
curl -s -H "X-API-Key: $TOKEN" \
  "$BASE/api/v1/daily-summary?date=$(TZ=Asia/Shanghai date +%F)&timezone=Asia%2FShanghai" | python3 -m json.tool

# 带 ETag 缓存
ETAG=$(curl -s -D- -o /dev/null -H "X-API-Key: $TOKEN" "$BASE/api/v1/daily-summary?date=2026-08-10&timezone=Asia%2FShanghai" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -H "X-API-Key: $TOKEN" -H "If-None-Match: $ETAG" "$BASE/api/v1/daily-summary?date=2026-08-10&timezone=Asia%2FShanghai"
```
