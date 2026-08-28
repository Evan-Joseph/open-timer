# 隐私与安全模型

Open Timer 面向自托管自己数据的单 owner 设计。

## Owner 访问

- 计时数据、项目、备注、会话、日报、导出、设置和 AI 配置均为 owner 专属。
- 公网部署不会被第一个访客抢占：生产环境要求 `CLOCK_INITIAL_OWNER_PIN`。
- owner 会话使用 HttpOnly、SameSite=Lax 的 cookie。任何非本地部署都应使用 HTTPS 并设置 `CLOCK_COOKIE_SECURE=true`。
- 写请求需要 owner 会话，并进行同源校验。

## 数据处理

- 时间戳以 UTC epoch 毫秒保存。
- 日视图和汇总以 Asia/Shanghai 作为自然日边界。
- 项目归档保留会话引用和历史，不删除记录。
- SQLite 备份、事件导出和会话备注可能包含敏感工作信息，请按私密数据处理。

## AI 助手

- AI 在 owner 配置前保持关闭。
- provider API Key 只经同源 owner 会话提交。
- Key 在保存前使用 `AI_CONFIG_ENCRYPTION_KEY` 进行 AES-GCM 加密。
- Key 不会从 API 返回、不会进入导出、不会写入日志，也不会保存在浏览器存储中。
- 应用接受公开 HTTPS OpenAI 兼容接口，并在生产环境拒绝本机、私网、链路本地和 IP 字面量地址。
- 发送 AI 请求会把相关的计时时间线和备注分享给 owner 选择的 provider，请据此选择信任的 provider。

## 运维职责

自托管意味着你负责 TLS、反向代理配置、备份、操作系统补丁，以及主机或 Cloudflare 账号的访问安全。请把部署密钥放在密钥管理中，并在 AI Key 可能泄露时轮换。

报告安全问题请遵循 [SECURITY.md](../../SECURITY.md) 中的指引。