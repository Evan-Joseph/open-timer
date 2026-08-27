# Contributing

Use Node.js 22+ and run `npm install`, `npm test`, `npm run typecheck`, and
`npm run build` before proposing a change. Do not commit `.env`, SQLite data,
Cloudflare resource IDs, access tokens, exported sessions, or screenshots that
contain personal data.

Changes to timer state transitions, authorization, migrations, or AI handling
need focused tests. Preserve the server-time and idempotency guarantees.
