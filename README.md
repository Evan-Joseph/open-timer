# 11408 沉浸时钟

单用户公网沉浸式学习计时器：选择科目 → 开始/暂停/继续/结束 → 北京时间日时间轴 + 总控只读 API。

新接手者先读：[`docs/接手提示词-沉浸时钟.md`](docs/接手提示词-沉浸时钟.md)（含第一条提示词）与 [`docs/DESIGN.md`](docs/DESIGN.md)（设计系统单一事实来源）；历史事实与 P0 契约见 [`docs/交接手册-沉浸时钟-2026-08-20.md`](docs/交接手册-沉浸时钟-2026-08-20.md)。

## 边界

- 本项目**只记录时间执行数据**。计时、科目选择和时间轴不能推断学习完成、正确率、覆盖或掌握。
- 真实作答、错因、闭卷提取、订正和间隔复习由根工作区 study-ledger 独占，本项目不写任何学习事件。
- 数据库 UTC 存储；自然日、显示与汇总一律 Asia/Shanghai（固定 +8）。

## 结构

```
shared/      领域层：状态机、日切、汇总、类型（provider-neutral，零云依赖）
server/      Hono API：路由/鉴权/幂等/限流 + SQLite 适配器（Storage 接口可替换）
web/         React SPA：三态时钟 + 日时间轴 + 浅深主题
migrations/  纯 SQL migration（SQLite/D1 交集语法）
e2e/         Playwright 端到端测试
docs/        设计与契约文档
```

## 本地开发

```bash
npm install
npm run test            # shared + server 单测/集成
npm run build -w web    # 前端产物到 web/dist
npm run start -w server # http://127.0.0.1:4517（静态前端 + API）
npm run test:e2e        # Playwright（自动起服务，端口 4390）
```

环境变量：`CLOCK_DATA_DIR`（数据目录，默认 ./data）、`CLOCK_DB_PATH`、`CLOCK_PORT`、`NODE_ENV=production` 启用 Secure cookie 与 HSTS。

## 鉴权

- 首次访问设置 owner 密码（argon2id）；登录后 HttpOnly + SameSite=Lax cookie，7 天有效。
- 总控只读凭据：`POST /api/v1/credentials`（owner）生成 `clk_…` token，仅显示一次；`POST /api/v1/credentials/:id/revoke` 撤销；支持轮换（新建+撤销）。

## 总控只读 API（v1）

| 端点 | 说明 |
| --- | --- |
| `GET /api/v1/health` | 健康检查 |
| `GET /api/v1/subjects` | 7 科目固定表 |
| `GET /api/v1/state` | 实时状态：是否在计时、今日累计、本段秒数（公开只读） |
| `GET /api/v1/sessions?date=YYYY-MM-DD` | 当日会话与段（含运行中） |
| `GET /api/v1/daily-summary?date=YYYY-MM-DD&timezone=Asia%2FShanghai` | 日报口径汇总，支持 ETag/If-None-Match |
| `GET /api/v1/export/events.jsonl` | owner-only 事件导出（可重放重建一切） |

写路径（owner cookie）：`POST /api/v1/sessions`（start）、`/:id/pause|resume|stop|switch|void|retime|adjust-start`、`PATCH /:id/note`。所有**会话写操作**必须携带 `Idempotency-Key`（8–64 字符）；同键重试回放原状态码与原响应体，并返回 `Idempotent-Replay: true`。auth/credentials 端点是连接与凭据管理，不要求幂等键，由限流保护。

契约见 `docs/openapi.yaml`。

## 可靠性要点

- 服务端时间是事实来源；前端用单调时钟（performance.now）平滑显示，任何响应都重新校准。
- 同一用户最多一个活动会话（部分唯一索引）；多标签页第二个 start 收到 409 并跟随。
- 刷新/休眠/后台节流不丢不重：净时长 = Σ(服务端段端点差)。
- 会话跨北京时间 00:00 不拆分；日报按窗口裁剪入账。
- 作废/修正保留事件链与 manual_adjustment 审计，不抹历史。
- 每日备份：Cron Triggers（北京 23:00）把 `events.jsonl`（与导出端点同格式，可重放）与 `sessions.jsonl` 写入 R2 `clock-11408-backup`，滚动保留 30 天（`server/src/backup.ts`）。

## 迁移

- Cloudflare（当前生产形态）：`server/` 同一 Hono 代码经 Workers 入口（`server/dist/worker.mjs`）+ D1 适配器（migrations 已用 SQL 交集）；前端静态由 **Worker Static Assets** 托管（`ASSETS` 绑定 + `run_worker_first`，SPA fallback 与安全头在 Worker 内统一处理），不使用 Pages。
- CloudBase：云函数 Node 运行时适配 Hono；数据库 adapter 换 MySQL 方言。
- 迁移前用 `GET /api/v1/export/events.jsonl` 全量导出重放对账。

## 安全清单

CSP（`script-src 'self'`，防闪白脚本已外置，无内联脚本）/ X-Frame-Options: DENY / nosniff / no-referrer / 生产 HSTS，统一覆盖 **API 与静态资源的所有响应**（含 404/500，实现见 `server/src/headers.ts`）；写请求 Origin 同源校验（CSRF）；登录与 API 限流（客户端 IP 优先取 Cloudflare 边缘写入、不可伪造的 `CF-Connecting-IP`，`X-Forwarded-For` 仅作非边缘环境降级）；日志不含 token/cookie/备注全文；公网错误不泄漏栈与路径。
