## Summary

Describe the user-visible change and why it is needed.

## Verification

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run test:e2e` (when the UI or a user flow changed)

## Safety checklist

- [ ] No API keys, owner PINs, session cookies, database files, exports, or
      personal timer data are included.
- [ ] Changes to authentication, migrations, timing, or AI handling include
      focused tests.
