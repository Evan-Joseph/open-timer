# 迁移清单：Cloudflare 优先（用户已选定倾向）

第一阶段全部本地；本文档是未来上云的替换点清单。任何一步都不改 `shared/` 领域层。

## → Cloudflare（首选）

| 能力 | 本地 V1 | Cloudflare 替换 | 备注 |
| --- | --- | --- | --- |
| API 运行时 | `@hono/node-server` | Workers（同一份 `server/src/app.ts`） | Hono 原生支持 Workers 入口 |
| 存储 | better-sqlite3 文件 | D1 | migrations 已用 SQL 交集；新写 `D1Storage implements Storage` |
| 静态前端 | server 托管 `web/dist` | Pages | API 走 `/api/*` 路由到 Worker |
| 密钥 | 环境变量 | Workers Secrets | token 只放服务端 |
| 定时备份 | `scripts/backup.sh` | Cron Triggers + R2 存副本 | 每日触发 D1 导出 |
| HTTPS/域名 | 无 | Cloudflare 托管域名 | 开 HSTS（config.isProduction） |
| 限流 | 进程内窗口 | Rate Limiting bindings / DO | 单用户量级可直接沿用进程内 |

迁移步骤：
1. `wrangler d1 create clock` 并回放 `migrations/*.sql`（已在本地 SQLite 验证）。
2. 实现 `server/src/repo/d1-storage.ts`（同 Storage 接口）+ 跑同一套 server 集成测试。
3. `events.jsonl` 全量导出 → 重放到 D1 → 双跑对账：同 date/revision 的 daily-summary 字节一致。
4. Pages 部署前端，绑定 Worker 路由；开 Secure cookie。

## → CloudBase（备选）

| 能力 | 替换 | 风险 |
| --- | --- | --- |
| API | 云函数 Node 运行时 + Hono 适配 | 专有 SDK，只在入口层使用 |
| 存储 | CloudBase 数据库（MySQL 方言）新 adapter | 方言差异比 D1 大，migration 需按 MySQL 重写一版 |
| 登录 | 保持自有 argon2id cookie 方案，不用 CloudBase 登录 | — |
| 域名 | 需备案 | 国内访问优势 |

## 回退

所有事实可从 `GET /api/v1/export/events.jsonl` 重放重建；迁移失败时本地 SQLite 仍是权威副本。
