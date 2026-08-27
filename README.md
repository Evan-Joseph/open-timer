# Open Timer

Open Timer is a private, self-hosted timer for individual or team work. It
keeps authoritative time on the server, supports pause/resume safely, and
shows a daily timeline. The owner manages projects in Settings; projects with
history are archived instead of deleted.

## One-command Docker deployment

This is the supported one-command path. It persists SQLite in a named Docker
volume.

```sh
cp .env.example .env
# edit .env: choose a unique six-digit CLOCK_INITIAL_OWNER_PIN and a long random AI_CONFIG_ENCRYPTION_KEY
docker compose up -d --build
```

Open `http://localhost:4517`, then log in using `CLOCK_INITIAL_OWNER_PIN`.
The initial owner is created before the server accepts requests, so a first
visitor cannot claim a public deployment. Back up the `open-timer-data` Docker
volume before upgrades.
Compose deliberately sets `CLOCK_COOKIE_SECURE=false` because localhost is
HTTP. Set it to `true` only when a reverse proxy terminates HTTPS.
Do not expose the direct HTTP container port to the public internet; put it
behind an HTTPS reverse proxy and set `CLOCK_COOKIE_SECURE=true`.

## AI assistant (optional)

Core timing works without AI. In **Settings → AI assistant**, an owner may
choose SiliconFlow (the OpenAI-compatible base is prefilled as
`https://api.siliconflow.cn/v1`) or any public HTTPS OpenAI-compatible API,
then enter a model and API key.

The key is sent only to the same-origin server, encrypted with
`AI_CONFIG_ENCRYPTION_KEY` using AES-GCM, and never returned by an API,
included in exports, logged, or stored in browser storage. Keep that encryption
secret stable: changing it makes previously stored AI keys unreadable and
requires re-entering them. The server rejects localhost, private, link-local,
and IP-literal AI endpoints in production.

## Privacy model

Timer data, project names, notes, sessions, and reports are owner-only by
default. There is no default public dashboard or wildcard CORS. Treat exports
and optional backups as sensitive because they can contain notes. The app does
not collect analytics or send timer data to an AI provider unless the owner
explicitly requests an AI recommendation.

## Cloudflare Workers + D1

Cloudflare requires resources in **your own account**; this repository has no
resource bindings, domains, database IDs, or deployment button that claims to
create them automatically.

```sh
npm install
npm run build
cp wrangler.example.jsonc wrangler.jsonc
# create a D1 database, then put its name and database_id in your local wrangler.jsonc
npx wrangler d1 create open-timer
# set required deployment secrets (never put these in wrangler.jsonc)
npx wrangler secret put CLOCK_INITIAL_OWNER_PIN
npx wrangler secret put AI_CONFIG_ENCRYPTION_KEY
npx wrangler deploy
```

Optional R2 backup needs a bucket you create yourself. Add its binding only to
your local deployment config and review backup retention before enabling it.
`wrangler.jsonc` is intentionally ignored by the public template.

## Development and verification

```sh
npm install
npm test
npm run typecheck
npm run build
npm run test:e2e
```

## Release hygiene

This worktree descends from a private project history. **Do not push its Git
history to a public remote.** Create a new repository from the current working
tree files, review the staged files for data and secrets, make a new first
commit, then publish that new repository.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
