# Cloudflare 配额与可靠性审计（2026-08-26）

> 触发背景：账户收到「Workers 和/或 Pages Functions 每日请求限额 75%」告警。Free 计划为 100,000 Workers 请求/日，75,000 时告警；超限后请求会失败至下一个 UTC 日重置。

## 审计结论

### 原始请求模型（告警根因）

1. 活动中前端每 3 秒并发请求 `/api/v1/state` 与 `/api/v1/sessions`：`86,400 / 3 × 2 = 57,600` Worker 请求/日/活动标签页。
2. owner 偏好每 15 秒请求一次：`86,400 / 15 = 5,760` 请求/日。
3. 单个持续活动客户端合计约 **63,360 请求/日**，已接近 75% 告警阈值；`run_worker_first: true` 还令首屏及每次静态资源重验证的 HTML/JS/CSS/字体也进入 Worker。

这足以解释告警，无需假设异常流量。

### 上线后请求模型

| 场景 | 轮询 | 日请求估算 | 说明 |
|---|---:|---:|---|
| 活动且可见 | `/api/v1/snapshot` 每 10s + prefs 每 5min | 8,640 + 288 = **8,928** | snapshot 合并原 state/sessions 两请求 |
| 空闲且可见 | snapshot 每 120s + prefs 每 5min | 720 + 288 = **1,008** | 时间显示由单调本地时钟外推 |
| 后台/隐藏 | 0 周期请求 | **0** | 返回前台立即校验 |
| 等待跨端备注 | 2s×30s → 10s×4.5min → 30s | < 50/次 | 仅结束卡展示期，分段退避 |

三台同时活动设备约 26,784 请求/日，约为 Free 日限额 27%；静态首屏资产 asset-first 后不再消耗 Worker 请求。

## 已实施的 Cloudflare 对齐措施

1. `assets.run_worker_first` 从 `true` 改为仅 `["/api/*"]`；静态 HTML/JS/CSS/字体 asset-first 直出。
2. 加 `assets.not_found_handling = "single-page-application"` 保持 SPA 路由 fallback。
3. `web/public/_headers` 为静态响应提供 CSP、XFO、nosniff、Referrer-Policy、HSTS；`/assets/*` 使用一年 immutable cache。Worker API 响应仍由 `headers.ts` 附加相同安全头。
4. 新增 `/api/v1/snapshot`，同一 Worker/D1 读取返回 state + 当前日 sessions，避免客户端双请求和跨日不一致。
5. 隐藏标签不轮询，恢复可见/焦点/bfcache/resume 时立即刷新，保留体验与可靠性。
6. 海螺缓存用单行 `conch_revision` 校验，已完成时间线不变时不调用 LLM。

## 仍建议在 Cloudflare 控制台完成的操作

- **Workers Analytics**：确认部署后 `/api/v1/snapshot` 成为主要动态路径，静态资源不再计入 Worker invocation。
- **WAF Rate Limiting**：对公网 `/api/v1/state`、`/api/v1/sessions`、`/api/v1/snapshot` 设置按 IP 的温和阈值（例如 120 次/分钟），防爬虫/扫描器消耗公共只读端点额度；不要限 owner 写路径到影响正常重试。
- **告警复核**：观察一个 UTC 日。若仍异常高，优先查 Workers Analytics 的 path 分布与 User-Agent，而非继续降低正常用户的活动同步频率。

## 官方参考

- Workers Static Assets binding / `run_worker_first`（2026-04-23）：https://developers.cloudflare.com/workers/static-assets/binding/
- Static Assets worker-script routing（2026-08-18）：https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- Static Assets custom `_headers`（2026-08-25）：https://developers.cloudflare.com/workers/static-assets/headers/
- Workers pricing / limits：https://developers.cloudflare.com/workers/platform/pricing/ 、https://developers.cloudflare.com/workers/platform/limits/
