# Configuration reference

Open Timer reads environment variables at process start. Keep secrets in your
deployment platform's secret store; do not commit them to `.env`,
`wrangler.jsonc`, screenshots, or issue reports.

## Required for production

| Variable | Required | Description |
| --- | --- | --- |
| `CLOCK_INITIAL_OWNER_PIN` | Yes | Exactly six digits. It claims the owner account before a public instance accepts requests. Docker Compose refuses to start when it is empty. |
| `AI_CONFIG_ENCRYPTION_KEY` | Required for owner-entered AI keys | A long random secret used to encrypt API keys at rest. Keep it stable; changing it makes existing encrypted AI keys unreadable. |

`AI_CONFIG_ENCRYPTION_KEY` is not required for basic timing, but the Docker
quick-start makes it mandatory so an owner can safely enable AI later.

## Runtime settings

| Variable | Default | Notes |
| --- | --- | --- |
| `CLOCK_PORT` | `4517` | HTTP listening port for the Node server. |
| `CLOCK_DATA_DIR` | `./data` | Directory that holds the SQLite database when `CLOCK_DB_PATH` is unset. Docker uses `/data`. |
| `CLOCK_DB_PATH` | `$CLOCK_DATA_DIR/clock.sqlite` | Explicit SQLite database path for Node deployments. |
| `CLOCK_BASE_URL` | `http://127.0.0.1:4517` | Base URL used by the Node configuration. |
| `NODE_ENV` | unset | Set to `production` for public deployments. |
| `CLOCK_COOKIE_SECURE` | follows `NODE_ENV` | `true` sends Secure owner cookies and requires HTTPS. Docker's localhost default is `false`; set it to `true` behind an HTTPS reverse proxy. |
| `CLOCK_MIN_SEGMENT_SECONDS` | `10` | Closed segments shorter than this are excluded as accidental starts. Set `0` to disable the filter. |

## Docker Compose-only setting

| Variable | Default | Notes |
| --- | --- | --- |
| `CLOCK_BIND_ADDRESS` | `127.0.0.1` | Host address used by Compose port publishing. Keep the default for local use; only change it deliberately for a trusted network or reverse proxy. |

## AI configuration

The recommended path is Settings → AI assistant, where the owner chooses a
provider, base URL, model, and key. The app supports SiliconFlow's
`https://api.siliconflow.cn/v1` preset and other public HTTPS
OpenAI-compatible endpoints.

For migration compatibility, these optional environment variables can provide a
fallback AI provider:

| Variable | Description |
| --- | --- |
| `CONCH_API_BASE` | OpenAI-compatible API base URL. |
| `CONCH_API_KEY` | Provider API key. Store it as a deployment secret. |
| `CONCH_MODEL` | Provider model identifier. |
| `CONCH_THINKING_BUDGET` | Optional positive integer thinking-token budget. |

The fallback is useful for existing automation, but Settings is preferred for
new deployments because it keeps provider configuration owner-managed and keys
encrypted in the app database.
