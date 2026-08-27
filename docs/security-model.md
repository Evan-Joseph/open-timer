# Privacy and security model

Open Timer is designed for a single owner who self-hosts their own data.

## Owner access

- Timer data, projects, notes, sessions, summaries, exports, settings, and AI
  configuration are owner-only.
- A public deployment cannot be claimed by a first visitor: production requires
  `CLOCK_INITIAL_OWNER_PIN`.
- Owner sessions are HttpOnly, SameSite=Lax cookies. Use HTTPS and
  `CLOCK_COOKIE_SECURE=true` for any non-local deployment.
- Write requests require the owner session and undergo same-origin checks.

## Data handling

- Timestamps are stored as UTC epoch milliseconds.
- Day views and summaries use Asia/Shanghai as their day boundary.
- Project archival preserves session references and history instead of deleting
  rows.
- SQLite backups, event exports, and session notes can contain sensitive work
  information. Treat them as private data.

## AI assistant

- AI is disabled until the owner configures it.
- Provider API keys are submitted only over the same-origin owner session.
- Keys are AES-GCM encrypted using `AI_CONFIG_ENCRYPTION_KEY` before storage.
- Keys are never returned by the API, included in exports, logged, or saved in
  browser storage.
- The app accepts public HTTPS OpenAI-compatible endpoints and rejects local,
  private, link-local, and IP-literal endpoints in production.
- Sending an AI request shares the relevant timer timeline and notes with the
  provider selected by the owner. Choose that provider accordingly.

## Operational responsibilities

Self-hosting means you control TLS, reverse-proxy configuration, backups,
operating-system patching, and access to the host or Cloudflare account. Keep
deployment secrets in a secret manager and rotate an AI key if it may have
leaked.

To report a vulnerability, follow [SECURITY.md](../SECURITY.md).
