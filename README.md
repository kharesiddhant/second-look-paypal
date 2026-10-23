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

## Cost per run (measured)

Token counts are from the app's own usage logs on the demo data. Prices are list prices per million tokens: Claude Sonnet 5.5 $2 in / $10 out, Claude Haiku 5.5 $0.10 in / $0.50 out.

### CSV reviews

| Batch | Lines | Model calls | Tokens in | Tokens out | Cost | Per line |
|---|---|---|---|---|---|---|
| Demo (`payout.csv`) | 7 | 1 × Sonnet 5.5 | 2,470 | 862 | $0.0136 | $0.0019 |
| Blind test (`blind-payout.csv`) | 8 | 1 × Sonnet 5.5 | 2,621 | 955 | $0.0148 | $0.0019 |
| Big demo (`big-payout.csv`) | 500 | 10 × Sonnet 5.5 (50-line chunks) | 73,432 | 3,682 | $0.1837 | $0.0004 |
| Reading one invoice PDF | – | 1 × Haiku 5.5 | ~2,210 | ~68 | $0.0003 | – |

Each call has about 1,430 fixed input tokens (instructions and output schema) plus about 96–120 per line, so the cost per line falls as batches grow. Output stays small because clean lines come back as bare line numbers.

### Agent drafts

Instruction: "Pay everyone who sent an invoice, except Raj. Add a $50 bonus for Sofia." with 5 invoice PDFs attached.

| Step | Model calls | Tokens in | Tokens out | Cost |
|---|---|---|---|---|
| Read 5 invoice PDFs | 5 × Haiku 5.5 | 11,044 | 341 | $0.0013 |
| Agent builds the draft (tool loop) | 6 × Sonnet 5.5 | 11,176 | 572 | $0.0281 |
| Review of the drafted batch | 1 × Sonnet 5.5 | 2,173 | 328 | $0.0076 |
| **Total per draft** | **12** | **24,393** | **1,241** | **$0.0370** |

The agent's tool loop is the largest part: every step resends the instructions, the tool definitions and the conversation so far. Its tools return short summaries rather than full line lists to keep that small.

### How the review cost came down

| Version | Tokens in | Tokens out | Cost per demo review |
|---|---|---|---|
| Raw files sent to the model, high effort | ~2,800 | ~2,700 | ~$0.033 |
| Code-built facts, medium effort | 3,264 | 1,917 | ~$0.026 |
| Compact facts, flagged lines only in the output | 2,470 | 862 | $0.014 |

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
