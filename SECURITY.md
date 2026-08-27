# Security policy

## Supported versions

Security fixes are provided for the latest release on the `main` branch. Please
upgrade before reporting an issue whenever practical.

## Reporting a vulnerability

Do **not** open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/Evan-Joseph/open-timer/security/advisories/new)
to send reproduction steps, impact, and the affected version privately. Do not
include API keys, database exports, session cookies, owner PINs, or personal
timer data unless they are strictly necessary for a private reproduction.

This project defaults to owner-only data access. Keep deployment secrets in your
host's secret store and rotate an AI provider key if it may have leaked.
