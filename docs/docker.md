# Docker deployment

Docker Compose with SQLite is the supported self-hosted path.

## First deployment

```sh
git clone https://github.com/Evan-Joseph/open-timer.git
cd open-timer
# Optional: install a named release instead of the moving main branch.
# git checkout v0.1.0
cp .env.example .env
```

Set a unique six-digit `CLOCK_INITIAL_OWNER_PIN` and a long random
`AI_CONFIG_ENCRYPTION_KEY` in `.env`, then run:

```sh
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:4517/api/v1/health
```

The Compose file binds the service to `127.0.0.1` by default. Do not expose the
plain HTTP port directly to the public internet. For public access:

1. Place Open Timer behind an HTTPS reverse proxy.
2. Set `CLOCK_COOKIE_SECURE=true` in `.env`.
3. Set `CLOCK_BIND_ADDRESS` to the address your proxy needs, typically
   `127.0.0.1` when the proxy runs on the same host.

## Data and backups

The named `open-timer-data` volume contains the SQLite database. Back it up
before upgrades:

```sh
docker compose exec open-timer /app/scripts/backup.sh
```

The script creates SQLite-consistent copies under `/data/backups` and retains
the newest 14 copies. Copy these files to storage outside the host.

For a full volume archive:

```sh
docker run --rm \
  -v open-timer-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.22 \
  tar czf /backup/open-timer-data-$(date +%F).tgz -C /data .
```

## Upgrade

1. Run a backup.
2. Pull the new source revision.
3. Rebuild and restart:

   ```sh
   git pull --ff-only
   docker compose up -d --build
   ```

Database migrations run automatically at startup. Do not change
`AI_CONFIG_ENCRYPTION_KEY`; doing so requires re-entering any stored AI keys.

## Restore

Stop the app before replacing a database:

```sh
docker compose down
```

Restore a known-good SQLite backup as `clock.sqlite` in the `open-timer-data`
volume, then start the app with `docker compose up -d`. Keep a copy of the
current volume until the restored instance has been verified.

For a complete volume archive, create a fresh volume and extract the archive
into it before starting Compose.
