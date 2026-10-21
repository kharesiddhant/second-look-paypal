# Second Look

A second pair of eyes before you pay people through PayPal. TODO: one-paragraph pitch.

## The problem

TODO: who has it, one real number.

## How it works

TODO: upload, review, resolve, approve, send, track.

## PayPal integration

TODO: Payouts REST (`lib/paypal.ts`, `app/api/batches/[id]/send/route.ts`), webhooks with signature verification (`app/api/webhooks/paypal/route.ts`), one batch per currency.

## AI usage

TODO: model, what it checks, where (`lib/review.ts`, `day1-test/reviewer-prompt.md`).

## Built with APIMatic

TODO: how the Context Plugin shaped the PayPal integration; Transaction Search via `@paypal/paypal-server-sdk`.

## Setup

TODO: Node 22+, `npm install`, `npm run dev`, sandbox accounts.

## Environment variables

TODO: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `ANTHROPIC_API_KEY`.

## Testing for judges

TODO: hosted URL, sample CSV, sandbox logins.

## License

MIT, see [LICENSE](LICENSE).
