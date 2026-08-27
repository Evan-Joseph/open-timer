# Changelog

All notable changes to Open Timer are documented here.

## v0.1.2 — 2026-08-27

- Ensure release-published container images are public and anonymously pullable
  from GitHub Container Registry.

## v0.1.1 — 2026-08-27

- Reworked the public README around product overview, a synthetic-data screenshot,
  Docker Compose quick start, and linked operational documentation.
- Added English and Simplified Chinese README entry points.
- Added version-controlled deployment, configuration, architecture, and security
  documentation.
- Added issue forms, a pull-request template, a Code of Conduct, Dependabot,
  GitHub private vulnerability reporting, and Docker CI smoke coverage.
- Hardened Docker defaults with localhost-only Compose port binding, a health
  check, non-root application runtime, and an in-container SQLite backup tool.
- Renamed internal workspace packages from `@clock/*` to `@open-timer/*`.
- Added versioned GitHub Container Registry publishing for future `v*` tags.

## v0.1.0 — 2026-08-27

First public release.

- Private-by-default, single-owner self-hosted timer.
- Server-authoritative sessions with pause, resume, daily timelines, and
  idempotent write paths.
- Owner-managed projects with grouping, color, ordering, and archival history.
- Optional encrypted AI assistant configuration for SiliconFlow and other
  OpenAI-compatible providers.
- Docker Compose + SQLite and Cloudflare Workers + D1 deployment paths.
