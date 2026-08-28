<div align="center">

# Open Timer

Track where your time goes, keep the data on your own server.

[简体中文](README.md) · English

[![CI](https://github.com/Evan-Joseph/open-timer/actions/workflows/ci.yml/badge.svg)](https://github.com/Evan-Joseph/open-timer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Evan-Joseph/open-timer?display_name=tag)](https://github.com/Evan-Joseph/open-timer/releases)
[![License](https://img.shields.io/github/license/Evan-Joseph/open-timer)](LICENSE)

</div>

![Open Timer](docs/images/open-timer-dashboard.png)

Open Timer is a self-hosted time tracker for deep work, study, meetings, and
client projects. Record time per project and review it on a daily timeline.

## Features

- **Accurate timing**: the server is the source of truth for time, so refreshes,
  sleep, and multiple tabs never lose or duplicate time.
- **Projects**: create projects with groups, colors, ordering, and archival.
- **Daily timeline**: review how your day was spent.
- **Optional AI assistant**: SiliconFlow and other OpenAI-compatible endpoints,
  with keys encrypted on the server.
- **Two deployment paths**: Docker Compose + SQLite, or Cloudflare Workers + D1.

## Quick start

Requires Docker.

```sh
git clone https://github.com/Evan-Joseph/open-timer.git
cd open-timer
cp .env.example .env
# Edit .env with CLOCK_INITIAL_OWNER_PIN and AI_CONFIG_ENCRYPTION_KEY.
docker compose up -d --build
```

Open <http://localhost:4517> and sign in with the PIN you set.

Compose listens on localhost by default. Put it behind an HTTPS reverse proxy
for public access; see the [Docker guide](docs/docker.md).

## Documentation

- [Docker deployment, backups, and upgrades](docs/docker.md)
- [Cloudflare Workers + D1](docs/cloudflare.md)
- [Configuration reference](docs/configuration.md)
- [Security model](docs/security-model.md)
- [Architecture](docs/architecture.md)

## Development

Requires Node.js 22 or later.

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Open an [issue](https://github.com/Evan-Joseph/open-timer/issues) for bugs and
suggestions. Report security issues through the [private route](SECURITY.md).

## License

[MIT](LICENSE). Bundled fonts are attributed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).