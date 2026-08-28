<div align="center">

# Open Timer

记录投入的时间，数据留在你自己的服务器上。

简体中文 · [English](README.en.md)

[![CI](https://github.com/Evan-Joseph/open-timer/actions/workflows/ci.yml/badge.svg)](https://github.com/Evan-Joseph/open-timer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Evan-Joseph/open-timer?display_name=tag)](https://github.com/Evan-Joseph/open-timer/releases)
[![License](https://img.shields.io/github/license/Evan-Joseph/open-timer)](LICENSE)

</div>

![Open Timer 界面](docs/images/open-timer-dashboard.png)

Open Timer 是一个自托管的时间记录工具。适合深度工作、学习、会议和客户项目——记录你花在每个项目上的时间，随时回看日时间轴。

## 特性

- **计时准确**：服务端是时间事实来源，刷新、休眠和多标签页都不会丢时或重复。
- **项目管理**：自定义项目，支持分组、颜色、排序和归档。
- **日时间轴**：按自然日回看每天的时间分布。
- **可选 AI 助手**：接入硅基流动等 OpenAI 兼容接口，密钥在服务端加密保存。
- **两种部署**：Docker Compose + SQLite，或 Cloudflare Workers + D1。

## 快速开始

需要 Docker。

```sh
git clone https://github.com/Evan-Joseph/open-timer.git
cd open-timer
cp .env.example .env
# 编辑 .env，填入 CLOCK_INITIAL_OWNER_PIN 和 AI_CONFIG_ENCRYPTION_KEY
docker compose up -d --build
```

打开 <http://localhost:4517>，用你设置的 PIN 登录。

Compose 默认只监听本机。公网部署请置于 HTTPS 反向代理之后，详见 [Docker 文档](docs/zh-CN/docker.md)。

## 文档

- [Docker 部署、备份与升级](docs/zh-CN/docker.md)
- [Cloudflare Workers + D1](docs/zh-CN/cloudflare.md)
- [配置参考](docs/zh-CN/configuration.md)
- [安全模型](docs/zh-CN/security-model.md)
- [架构](docs/zh-CN/architecture.md)

## 开发

需要 Node.js 22 或更新版本。

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Bug 或建议请提 [Issue](https://github.com/Evan-Joseph/open-timer/issues)。安全问题走 [私密报告](SECURITY.md)。

## 许可

[MIT](LICENSE)。内置字体见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。