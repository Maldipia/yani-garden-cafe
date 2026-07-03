# API Action Contract — how the lock works

## What this protects against

On 29 Jun 2026, commit `cc8a85e` (an HR edit-modal change) accidentally deleted
~55 API actions from `api/handlers/admin.js` while only meaning to touch HR.
Nobody noticed for days. Members, Inventory, Analytics, Cash Sessions, Promo
Codes, Reservations, Refunds and Settings pages all silently broke — every
button returned `Unknown action`.

This guard makes that class of regression **impossible to ship unnoticed**.

## How it works

`scripts/action-manifest.txt` is the **locked contract**: every API action the
frontend depends on. `scripts/check-actions.mjs`:

1. Reads the manifest (what must always work).
2. Scans every `.html`/`.js` file for what the frontend actually calls.
3. Scans `api/**/*.js` for what the backend can actually answer.
4. **Fails the build** if any locked/called action has no handler.

It runs automatically on every push and PR (`.github/workflows/guard.yml`),
and locally via `npm run guard`.

## Daily rules

- **Adding a feature?** Build the frontend call *and* the handler. Run
  `npm run guard`. If it warns "new action not locked", add it to
  `scripts/action-manifest.txt`. Done.
- **Retiring a feature?** Remove it from the frontend **and** from
  `action-manifest.txt` in the same commit. The guard only complains when the
  frontend still calls something the backend can't answer.
- **Never** delete a handler without first checking `npm run guard`.

## Regenerating the manifest (rare)

Only when you intentionally want to re-baseline the whole surface:

```bash
node -e '...'   # see git history of this file; or ask, and re-freeze current state
npm run guard   # must print "0 broken"
```

The manifest should only ever grow (new features) or shrink deliberately
(retired features) — never change silently.
