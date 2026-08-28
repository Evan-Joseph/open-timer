# Changelog

All notable changes to Open Timer are documented here.

A Simplified Chinese translation is available in [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## v0.1.3 — 2026-08-28

- Made Simplified Chinese the default README (`README.md`), with the English
  README moved to `README.en.md`.
- Added a Chinese documentation home (`docs/README.md`) and translated
  operational documentation under `docs/zh-CN/`.
- Updated repository description to be bilingual and aligned release notes with
  the changelog.

## v0.1.2 — 2026-08-27

- Removed the unavailable GitHub Container Registry distribution path from the
  public documentation. Docker Compose source deployments remain the supported,
  tested installation path.

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

## v0.1.0 — 2026-08-27

First public release.

- Private-by-default, single-owner self-hosted timer.
- Server-authoritative sessions with pause, resume, daily timelines, and
  idempotent write paths.
- Owner-managed projects with grouping, color, ordering, and archival history.
- Optional encrypted AI assistant configuration for SiliconFlow and other
  OpenAI-compatible providers.
- Docker Compose + SQLite and Cloudflare Workers + D1 deployment paths.
