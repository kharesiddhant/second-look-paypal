# APIMatic Context Plugin log

A running record of where the APIMatic Context Plugin (PayPal Server SDK skills) shaped Second Look's PayPal integration. Source material for the README section "Built with APIMatic Context Plugin" and the demo video.

Plugin: `paypal@context-plugins-local`, installed with `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview` into Claude Code (VS Code extension). SDK: `@paypal/paypal-server-sdk` 2.5.0, pinned exactly as the plugin recommends.

| Date | Skill | Why we loaded it | What it changed or confirmed |
|---|---|---|---|
| 2026-10-22 | `typescript-getting-started` | Entry point before writing any Server SDK code for history import (Transaction Search). | Pinned the SDK to exactly `2.5.0` instead of a caret range. Taught us to read `src/configuration.ts` for the real credentials property name rather than guess it. |
| 2026-10-22 | `typescript-client-initialization` | Before constructing the SDK `Client`. | Client takes one options object, no builder. Auth goes in `clientCredentialsAuthCredentials` (read from source); environment is `Environment.Sandbox`. Controllers are constructed by us (`new TransactionSearchController(client)`), not accessed on the client. Build the client once and reuse it so the OAuth token is cached. |
| 2026-10-22 | `typescript-calling-endpoints` | Before the first `searchTransactions` call. | Warned that operations come in two parameter forms. `searchTransactions` takes one options object (`{ startDate, endDate, fields, pageSize }`), not positional arguments; results are on `response.result`; errors throw `ApiError`. |
| 2026-10-22 | `typescript-error-handling` | Before the first try/catch around `searchTransactions`. | Read the operation's `req.defaultToError(SearchError, …)` line instead of guessing the error class. Checked that `SearchError` is not shadowed by a same-named model (`typeof sdk.SearchError === 'function'`). Read the payload with its wire field names (`e.result.message`, `debug_id`), not camelCase. Kept an `ApiError` catch-all and rethrow for network errors. Code: `lib/history.ts`. |

## Findings along the way

- 2026-10-22: First sandbox `searchTransactions` call returned `403 NOT_AUTHORIZED` ("insufficient permissions"). Cause: the app did not have the Transaction Search feature enabled. Fixed in Developer Dashboard → app → Features → Transaction search.
- 2026-10-22: Permission became active on the token after some delay. First sync through `TransactionSearchController.searchTransactions`: 46 payout rows (event code `T0001`), every one with the recipient email in `payer_info`. Names come from the recipients' PayPal profiles, not our CSV. Older payouts had no invoice ID because notes only started carrying it today.
