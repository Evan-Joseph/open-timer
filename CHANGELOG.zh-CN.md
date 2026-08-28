# 更新日志

## v0.1.4 — 2026-08-28

- 重写 README 为简洁的产品首页，去掉累赘的防御性说明。简体中文保持默认入口，英文版位于 `README.en.md`。

## v0.1.3 — 2026-08-28

- README 改为简体中文默认入口，英文版移入 `README.en.md`。
- 新增 `docs/README.md` 中文文档首页与 `docs/zh-CN/` 中文操作文档。
- 更新仓库描述为双语，并同步版本发布说明。

## v0.1.2 — 2026-08-27

- 从公开文档中移除不可用的 GitHub Container Registry 分发路径；Docker Compose 源码部署仍是被支持的、经过测试的安装方式。

## v0.1.1 — 2026-08-27

- 围绕产品概览、示例数据截图、Docker Compose 快速开始和操作文档重写公开 README。
- 增加中英文 README 入口；补充部署、配置、架构与安全文档。
- 增加 Issue 表单、PR 模板、行为准则、Dependabot、GitHub 私密漏洞报告和 Docker CI 冒烟覆盖。
- 加固 Docker 默认配置：Compose 仅绑定本机、健康检查、非 root 运行、容器内 SQLite 备份工具。
- 内部工作区包从 `@clock/*` 重命名为 `@open-timer/*`。

## v0.1.0 — 2026-08-27

首个公开版本。

- 默认私密、单 owner 的自托管计时。
- 服务端为事实来源的会话：暂停、继续、日时间轴、幂等写入。
- 可管理项目：分组、颜色、排序与归档历史。
- 可选的加密 AI 助手配置（硅基流动等其他 OpenAI 兼容接口）。
- Docker Compose + SQLite 与 Cloudflare Workers + D1 两种部署方式。