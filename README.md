# Second Look

A second pair of eyes before you pay people through PayPal. TODO: one-paragraph pitch.

## The problem

TODO: who has it, one real number.

## How it works

TODO: upload, review, resolve, approve, send, track.

## PayPal integration

TODO: Payouts REST (`lib/paypal.ts`, `app/api/batches/[id]/send/route.ts`), webhooks with signature verification (`app/api/webhooks/paypal/route.ts`), one batch per currency.

## AI usage

TODO: model, what it checks, where (`lib/review.ts`, `lib/reviewer-prompt.md`, `lib/guards.ts`).

## Built with APIMatic

TODO: how the Context Plugin shaped the PayPal integration; Transaction Search via `@paypal/paypal-server-sdk`.

## Scaling

Batches of up to 50 lines are reviewed in one call while the owner waits. Bigger batches (up to 500 lines) are saved at once and reviewed in the background in 50-line chunks, in parallel, with a progress bar.

- **Render Workflows:** with `RENDER_WORKFLOW_SLUG` set, each chunk is a task run of the `reviewChunk` task (`workflows/review.ts`, retries with backoff, idempotency key per chunk). Without it (local development), chunks run in-process. Both paths store results the same way (`lib/chunks.ts`).
- **No context lost by splitting:** facts are computed by code over the whole batch first (duplicates, repeats, same recipient across chunks), then split. Each chunk gets only the notes about its lines, plus notes that concern no line.
- **Failure:** a chunk with no answer after its retries leaves its lines as "AI review unavailable" for the owner to check; the code floor still applies to them.
- **Cost:** measured about 1,430 fixed input tokens per call plus about 96 per line; clean lines come back as bare line numbers. Big batches use a code-written summary.

Demo: **Load big demo** reviews 500 creator payouts (`day1-test/big-payout.csv`, answer key in `day1-test/big-answer-key.md`). Sending it creates 500 sandbox payouts to addresses without sandbox accounts, which come back unclaimed.

## Setup

TODO: Node 22+, `npm install`, `npm run dev`, sandbox accounts.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | yes | PayPal sandbox app (US business account as sender; Transaction search enabled) |
| `PAYPAL_WEBHOOK_ID` | yes | Webhook signature verification |
| `ANTHROPIC_API_KEY` | yes | Claude Sonnet 5.5 review, Claude Haiku 5.5 invoice reading |
| `APP_PASSWORD` | yes | Shared sign-in password. Without it nobody can sign in (fails closed). |
| `DEMO` | no | `1` seeds demo history, enables the Load demo button and the demo rules |
| `DB_PATH` | no | SQLite file location; default `data/second-look.db`. Point it at a persistent disk in production. |
| `UNCLAIMED_NUDGE_HOURS` | no | Hours before an unclaimed payout is highlighted; default 72 |
| `REVIEW_MODE` | no | `stub` skips the AI call for the demo CSV only (UI testing) |
| `RENDER_WORKFLOW_SLUG`, `RENDER_API_KEY` | no | Run big-batch chunks on Render Workflows; unset = in-process |

## Privacy

Payout lines (names, emails, amounts), invoices and pasted notes are sent to the Anthropic API for review and invoice reading. Nothing is sent to other third parties apart from PayPal. Data is stored in a local SQLite file.

## Testing for judges

TODO: hosted URL, sample CSV, sandbox logins.

## License

MIT, see [LICENSE](LICENSE).
