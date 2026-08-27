# Architecture

Open Timer is a small TypeScript monorepo:

```text
shared/      Domain types, time rules, summaries, and AI-context helpers
server/      Hono API, authentication, storage adapters, Workers entry point
web/         React/Vite single-page application
migrations/  SQLite/D1-compatible schema migrations
e2e/         Playwright product-flow tests
```

The Node server uses SQLite through `better-sqlite3`. The Cloudflare Workers
entry point uses the same application layer with a D1 adapter. Both paths share
the state-transition and summary logic in `shared/`.

Server time is authoritative. The web app uses monotonic-clock anchors only to
render smoothly between server updates; it does not invent session duration.
