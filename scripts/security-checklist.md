# Security verification checklist

Run before calling implementation complete.

## Automated

- `pnpm exec tsx lib/security.test.ts`
- `pnpm audit`
- `python3 -m pip_audit -r requirements.txt` when pip-audit is available

## AuthZ / IDOR

- Unauthenticated GET `/api/history` returns 401
- Unauthenticated POST `/api/search` returns 401
- Authenticated user A cannot read user B history via guessed UUIDs
- Instagram session blobs are never returned by `/api/account` or `/api/instagram/status`

## Webhooks

- Stripe webhook without signature returns 400
- Replay of the same `stripe_event_id` is ignored via `webhook_receipts`
- Billing entitlement is derived from latest `customer.subscription*` event, not client input

## Input / abuse

- Instagram connect rejects missing credentials with 400
- Instagram connect rate-limits after repeated failures
- Search query longer than 500 characters is rejected
- History hide requires a UUID and never hard-deletes source rows

## Sensitive data

- Instagram password is not written to logs, files, or database columns
- `IG_SESSION_ENCRYPTION_KEY` is required to decrypt session blobs
- `.env` remains gitignored
