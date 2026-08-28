<div align="center">

# Open Timer

**私密、准确、可自托管的工作计时器。**

简体中文 · [English](README.en.md) · [文档](docs/README.md) · [版本发布](https://github.com/Evan-Joseph/open-timer/releases) · [安全报告](SECURITY.md)

[![CI](https://github.com/Evan-Joseph/open-timer/actions/workflows/ci.yml/badge.svg)](https://github.com/Evan-Joseph/open-timer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Evan-Joseph/open-timer?display_name=tag)](https://github.com/Evan-Joseph/open-timer/releases)
[![License](https://img.shields.io/github/license/Evan-Joseph/open-timer)](LICENSE)

</div>

![Open Timer 仪表盘：正在进行的专注会话和日时间轴](docs/images/open-timer-dashboard.png)

> 截图只使用示例数据，不包含真实项目、备注或计时记录。

Open Timer 是一个默认私密、单 owner 使用的自托管计时器。适合深度工作、学习、会议、客户项目，或任何你想长期记录投入时间的事情。

## 为什么用它？

- **默认私密**：项目、备注、会话、日报和导出都要求 owner 登录；没有公开看板和通配 CORS。
- **计时可信**：服务端是时间事实来源。暂停、继续、休眠、刷新和多标签页不会重复或丢失时间。
- **项目自己管**：在设置中新增、改名、分组、改颜色、排序和归档；归档不会破坏历史会话。
- **日时间轴**：时间戳使用 UTC 保存，日视图和汇总按 Asia/Shanghai 划分自然日。
- **可选 AI 助手**：支持硅基流动和其他 HTTPS OpenAI 兼容接口；API Key 仅在服务端 AES-GCM 加密保存。
- **不绑平台**：Docker Compose + SQLite 是推荐路径，也支持 Cloudflare Workers + D1。

## 快速开始：Docker Compose

前提：Docker Desktop，或带 Compose 插件的 Docker Engine。

```sh
git clone https://github.com/Evan-Joseph/open-timer.git
cd open-timer

# 可选：想固定到某个发布版本时，在 Releases 页面选好 tag 后执行：
# git checkout <release-tag>

cp .env.example .env
```

编辑 `.env`，填写以下两个值：

```dotenv
# 恰好六位数字；首次启动时用于创建 owner。
CLOCK_INITIAL_OWNER_PIN=123456

# 生成命令：openssl rand -base64 32
# 这个值部署后必须保持不变，否则已保存的 AI Key 无法解密。
AI_CONFIG_ENCRYPTION_KEY=paste-a-long-random-value-here
```

启动并检查健康状态：

```sh
docker compose up -d --build
curl http://127.0.0.1:4517/api/v1/health
```

打开 <http://localhost:4517>，用 `CLOCK_INITIAL_OWNER_PIN` 登录。

Compose 默认只绑定本机 `127.0.0.1`。如需公网访问，请放在 HTTPS 反向代理之后，并将 `CLOCK_COOKIE_SECURE=true`。备份、升级、恢复和反向代理说明见 [Docker 部署文档](docs/zh-CN/docker.md)。

## 文档

- [文档首页](docs/README.md)
- [Docker 部署、备份、升级与恢复](docs/zh-CN/docker.md)
- [Cloudflare Workers + D1 部署](docs/zh-CN/cloudflare.md)
- [配置参考](docs/zh-CN/configuration.md)
- [隐私与安全模型](docs/zh-CN/security-model.md)
- [架构说明](docs/zh-CN/architecture.md)
- [更新日志](CHANGELOG.zh-CN.md)

## AI 助手

AI 是可选功能，核心计时不依赖它。在 **设置 → AI 助手** 中，owner 可以选择硅基流动（已预填 `https://api.siliconflow.cn/v1`）或其他公开 HTTPS OpenAI 兼容接口，再填写模型和 API Key。

Key 仅经同源 owner 会话提交，使用 `AI_CONFIG_ENCRYPTION_KEY` 进行 AES-GCM 加密；不会从 API 返回、不会进入导出、不会写入日志，也不会储存在浏览器中。启用前请阅读 [隐私与安全模型](docs/zh-CN/security-model.md)。

## 开发

需要 Node.js 22 或更新版本。

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
```

## 参与与安全

欢迎提交 Bug 和功能建议。提 PR 前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 中的私密路径报告；不要在公开 Issue 中提交密钥、Cookie、导出文件或个人计时数据。

如果 Open Timer 对你有帮助，欢迎点 Star 并分享给同样希望把时间记录留在自己手里的人。

## 许可

Open Timer 使用 [MIT License](LICENSE)。字体等第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
