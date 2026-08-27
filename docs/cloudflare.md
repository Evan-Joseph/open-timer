# Cloudflare Workers + D1 deployment

This route runs the same app on Cloudflare Workers with D1 storage and static
assets. You create all Cloudflare resources in your own account; the repository
contains no production database IDs, domains, routes, or buckets.

## Prerequisites

- A Cloudflare account.
- Node.js 22 or later.
- A unique six-digit owner PIN.
- A stable random `AI_CONFIG_ENCRYPTION_KEY`.

## Deploy

```sh
npm ci
npm run build
npx wrangler d1 create open-timer
cp wrangler.example.jsonc wrangler.jsonc
```

Put the D1 name and ID printed by Wrangler into your local `wrangler.jsonc`.
That file is intentionally ignored by Git.

Set secrets without putting them in the configuration file:

```sh
npx wrangler secret put CLOCK_INITIAL_OWNER_PIN
npx wrangler secret put AI_CONFIG_ENCRYPTION_KEY
npx wrangler deploy
```

Open the Workers URL or your configured custom domain, then sign in with the
owner PIN. Migrations run automatically and are version-recorded in D1.

## Optional R2 backups

R2 is optional. To enable it:

1. Create an R2 bucket in your account.
2. Add an `r2_buckets` binding named `BACKUP` to your local
   `wrangler.jsonc`.
3. Add a cron trigger appropriate for your retention policy.

Without the binding, backup requests return a clear “not configured” response
and scheduled events safely skip backup work.

## Notes

- Workers always use Secure owner cookies, so use HTTPS.
- The AI assistant is configured by the owner in Settings. The encryption secret
  must remain unchanged while encrypted keys exist.
- Export data and test an upgrade in a non-production D1 database before making
  material changes to a long-lived deployment.
