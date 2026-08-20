# 迁移清单：Cloudflare 优先（用户已选定倾向）

第一阶段全部本地；本文档是上云的替换点清单。任何一步都不改 `shared/` 领域层。
**2026-08 状态：Cloudflare 迁移已落地为生产形态**（Worker `immersive-clock-11408` + D1 `clock-11408` + custom domain `clock.4c666.top`），下表按现状校准。

## → Cloudflare（首选，已实施）

| 能力 | 本地 V1 | Cloudflare 替换 | 备注 |
| --- | --- | --- | --- |
| API 运行时 | `@hono/node-server` | Workers（同一份 `server/src/app.ts`） | Hono 原生支持 Workers 入口（`server/src/worker.ts`） |
| 存储 | better-sqlite3 文件 | D1 | migrations 已用 SQL 交集；`D1Storage implements Storage` |
| 静态前端 | server 托管 `web/dist` | **Worker Static Assets**（`ASSETS` 绑定 + `run_worker_first`） | 不用 Pages；SPA fallback 与安全头在 Worker 内统一处理 |
| 密钥 | 环境变量 | Workers Secrets | token 只放服务端 |
| 定时备份 | `scripts/backup.sh` | Cron Triggers + R2 存副本 | 每日触发 D1 导出（待实施；当前兜底是 events.jsonl 导出） |
| HTTPS/域名 | 无 | custom domain `clock.4c666.top` | 已开 HSTS（config.isProduction）；`workers_dev: false` |
| 限流 | 进程内窗口 | Rate Limiting bindings / DO | 单用户量级沿用进程内；客户端 IP 取 CF-Connecting-IP |

迁移步骤（已执行，留档供二次迁移参考）：
1. `wrangler d1 create clock` 并回放 `migrations/*.sql`（已在本地 SQLite 验证）。
2. 实现 `server/src/repo/d1-storage.ts`（同 Storage 接口）+ 跑同一套 server 集成测试。
3. `events.jsonl` 全量导出 → 重放到 D1 → 双跑对账：同 date/revision 的 daily-summary 字节一致。
4. Worker Static Assets 部署前端（`wrangler.jsonc` 的 `assets.directory` 指向 `web/dist`）；开 Secure cookie。

## → CloudBase（备选）

| 能力 | 替换 | 风险 |
| --- | --- | --- |
| API | 云函数 Node 运行时 + Hono 适配 | 专有 SDK，只在入口层使用 |
| 存储 | CloudBase 数据库（MySQL 方言）新 adapter | 方言差异比 D1 大，migration 需按 MySQL 重写一版 |
| 登录 | 保持自有 argon2id cookie 方案，不用 CloudBase 登录 | — |
| 域名 | 需备案 | 国内访问优势 |

## 回退

所有事实可从 `GET /api/v1/export/events.jsonl` 重放重建；迁移失败时本地 SQLite 仍是权威副本。
