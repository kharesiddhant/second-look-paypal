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

Measured on the test batches (Claude Sonnet 5.5, medium effort): about 1,430 fixed input tokens per batch (prompt + output schema) plus about 96 per line. Code pre-computes the facts for each line (invoice match, history summary, duplicates, same recipient), so the model judges instead of searching raw files. Clean lines come back as bare line numbers; only flagged lines carry detail.

| Batch | Input tokens | Notes |
|---|---|---|
| 8 lines | ~2,500 | measured: ~$0.015 per review |
| 100 lines | ~11,000 | estimate |
| 500 lines | ~49,000 | estimate |

Known limit: one review is one model call with `max_tokens` 16,000, estimated to hold about 100 flagged lines. Plan for larger batches:

1. Split the batch into chunks of ~50 lines reviewed in parallel. Cross-line facts (duplicates, same recipient) are computed in code over the whole batch first, so chunks lose nothing.
2. Run the review as a background job with progress (Render Workflows).
3. Offer the Message Batches API (50% cheaper, results within 24 hours) for owners who review overnight.

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

## Privacy

Payout lines (names, emails, amounts), invoices and pasted notes are sent to the Anthropic API for review and invoice reading. Nothing is sent to other third parties apart from PayPal. Data is stored in a local SQLite file.

## Testing for judges

TODO: hosted URL, sample CSV, sandbox logins.

## License

MIT, see [LICENSE](LICENSE).
