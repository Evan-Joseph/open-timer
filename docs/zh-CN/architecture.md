# 架构说明

Open Timer 是一个小型的 TypeScript monorepo：

```text
shared/      领域类型、时间规则、汇总、AI 上下文辅助
server/      Hono API、鉴权、存储适配器、Workers 入口
web/         React/Vite 单页应用
migrations/  兼容 SQLite/D1 的 schema 迁移
e2e/         Playwright 产品流程测试
```

Node 服务通过 `better-sqlite3` 使用 SQLite；Cloudflare Workers 入口使用同一应用层的 D1 适配器。两条部署路径共享 `shared/` 中的状态迁移与汇总逻辑。

服务端时间是事实来源。前端只在两次服务端更新之间使用单调时钟锚点做平滑渲染，不自行生成会话时长。