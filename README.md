# Open Timer

[中文说明](README.zh-CN.md) · [Documentation](#documentation) · [Report a vulnerability](SECURITY.md)

[![CI](https://github.com/Evan-Joseph/open-timer/actions/workflows/ci.yml/badge.svg)](https://github.com/Evan-Joseph/open-timer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Evan-Joseph/open-timer?display_name=tag)](https://github.com/Evan-Joseph/open-timer/releases)
[![License](https://img.shields.io/github/license/Evan-Joseph/open-timer)](LICENSE)

**A private-by-default, self-hosted work timer with server-authoritative tracking, owner-managed projects, and daily timelines.**

![Open Timer dashboard with a running Deep work session and daily timeline](docs/images/open-timer-dashboard.png)

Open Timer is for people who want a calm, single-owner timer without sending their
work history to a hosted service. It works for deep work, study, meetings, client
work, or any project you want to time.

## Highlights

- **Private by default** — projects, notes, sessions, and reports require the
  owner session. There is no public dashboard or wildcard CORS.
- **Accurate timing** — the server is the source of truth; pause, resume, sleep,
  refresh, and multiple tabs do not create duplicate or lost time.
- **Projects you control** — create, rename, group, color, order, and archive
  projects in Settings. Archived projects retain their history.
- **Useful history** — daily timelines and summaries use Asia/Shanghai for their
  day boundary while all stored timestamps remain UTC.
- **Optional AI assistant** — configure SiliconFlow or another public HTTPS
  OpenAI-compatible provider in Settings. API keys are encrypted on the server
  and are never returned to the browser.
- **Self-host your way** — Docker Compose with SQLite is the supported quick
  start; Cloudflare Workers + D1 is also supported.

## Quick start with Docker Compose

Prerequisites: Docker Desktop or Docker Engine with the Compose plugin.

```sh
git clone https://github.com/Evan-Joseph/open-timer.git
cd open-timer
# Optional: install a named release instead of the moving main branch.
# git checkout v0.1.0
cp .env.example .env
```

Edit `.env` before starting:

```dotenv
# Exactly six digits; used to claim the owner account at first boot.
CLOCK_INITIAL_OWNER_PIN=123456

# Generate a unique value and keep it stable after deployment:
# openssl rand -base64 32
AI_CONFIG_ENCRYPTION_KEY=paste-a-long-random-value-here
```

Then start the app:

```sh
docker compose up -d --build
curl http://127.0.0.1:4517/api/v1/health
```

Open <http://localhost:4517> and sign in with `CLOCK_INITIAL_OWNER_PIN`.

Compose binds to `127.0.0.1` by default. Put it behind an HTTPS reverse proxy
before exposing it publicly, then set `CLOCK_COOKIE_SECURE=true`. See the
[Docker guide](docs/docker.md) for backups, upgrades, remote access, and restore
guidance.

Version tags publish a container image to
[`ghcr.io/evan-joseph/open-timer`](https://github.com/Evan-Joseph/open-timer/pkgs/container/open-timer).

## Documentation

- [Docker deployment, backups, upgrades, and restore](docs/docker.md)
- [Cloudflare Workers + D1 deployment](docs/cloudflare.md)
- [Configuration reference](docs/configuration.md)
- [Privacy and security model](docs/security-model.md)
- [Architecture overview](docs/architecture.md)
- [Changelog](CHANGELOG.md)

## AI assistant

AI is optional; core timing works without it. In **Settings → AI assistant**, an
owner can choose SiliconFlow (pre-filled with
`https://api.siliconflow.cn/v1`) or another public HTTPS OpenAI-compatible
endpoint, then provide a model and API key.

Keys travel only over the same-origin owner session, are encrypted with
`AI_CONFIG_ENCRYPTION_KEY` using AES-GCM, and are never returned by the API,
included in exports, logged, or stored in browser storage. Read the
[security model](docs/security-model.md) before enabling a provider.

## Development

Open Timer requires Node.js 22 or later.

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
```

## Contributing and security

Bug reports and feature requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. For security
issues, use the private reporting route described in [SECURITY.md](SECURITY.md);
do not include credentials, cookies, exports, or personal timer data in a public
issue.

## License

Open Timer is licensed under the [MIT License](LICENSE). Bundled font notices
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
