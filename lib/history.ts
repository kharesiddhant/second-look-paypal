// Past payouts imported from PayPal Transaction Search through the APIMatic-generated Server SDK.
// Imported rows sit next to the seeded demo rows in the history table, labelled source = 'paypal'.
import { Client, Environment, TransactionSearchController, SearchError, ApiError } from '@paypal/paypal-server-sdk';
import type { TransactionDetails } from '@paypal/paypal-server-sdk';
import { db } from './db';

// Built once and reused, so the SDK caches its OAuth token (plugin: typescript-client-initialization).
let client: Client | null = null;
const sdk = () => client ??= new Client({
  environment: Environment.Sandbox,
  timeout: 30000,
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID ?? '',
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
  },
});

// T0001 = Payouts. Confirmed on the first sandbox sync (2026-10-22): 46 rows, one per payout item we sent.
const PAYOUT_CODES = ['T0001'];
// Owner's rule: only completed payouts count as paid history. Unclaimed or returned ones show 'P' (seen in sandbox).
const PAID_STATUS = 'S';
const WINDOWS = 3;    // owner's choice: 3 months, fetched as 3 windows of 30 days (the API allows at most 31)
const DAY = 864e5;

// Our payout notes start with the invoice ID ("OD-10 · October dev work"), so it survives the round trip.
const invoiceFrom = (note?: string) => note?.match(/^(\S+) · /)?.[1] ?? '';

function toRow(t: TransactionDetails) {
  const info = t.transactionInfo ?? {};
  const payer = t.payerInfo ?? {};
  const name = payer.payerName?.alternateFullName
    ?? [payer.payerName?.givenName, payer.payerName?.surname].filter(Boolean).join(' ');
  return {
    txnId: info.transactionId ?? '',
    date: (info.transactionInitiationDate ?? '').slice(0, 10),
    name,
    email: payer.emailAddress ?? '', // empty = recipient unknown; such rows never match a line
    amount: Math.abs(Number(info.transactionAmount?.value ?? 0)).toFixed(2), // outgoing amounts are negative
    currency: info.transactionAmount?.currencyCode ?? '',
    invoice: invoiceFrom(info.transactionNote) || (info.invoiceId ?? ''),
  };
}

// Fetches one date range page by page. PayPal refuses ranges with more than 10,000 transactions
// (RESULTSET_TOO_LARGE); such a range is split in half until it fits, down to one day.
async function fetchRange(api: TransactionSearchController, start: number, end: number, out: Map<string, TransactionDetails>) {
  for (let page = 1, pages = 1; page <= pages; page++) {
    try {
      // One options object, not positional arguments (plugin: typescript-calling-endpoints).
      const res = await api.searchTransactions({
        startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), fields: 'all', pageSize: 500, page,
      });
      pages = res.result.totalPages ?? 1;
      for (const t of res.result.transactionDetails ?? []) out.set(t.transactionInfo?.transactionId ?? `${out.size}`, t);
    } catch (e) {
      // Typed SearchError carries the parsed payload; snake_case fields as on the wire (plugin: typescript-error-handling).
      if (e instanceof SearchError && e.result?.name === 'RESULTSET_TOO_LARGE' && end - start > DAY) {
        const mid = start + Math.floor((end - start) / 2);
        await fetchRange(api, start, mid, out);
        await fetchRange(api, mid, end, out);
        return;
      }
      if (e instanceof SearchError) {
        const hint = e.statusCode === 403 ? ' Is Transaction search enabled for this app, and active on its token yet?' : '';
        throw new Error(`Transaction Search ${e.statusCode}: ${e.result?.message ?? e.result?.name ?? 'error'}.${hint}`);
      }
      if (e instanceof ApiError) throw new Error(`Transaction Search ${e.statusCode}: ${String(e.body).slice(0, 200)}`);
      throw e;
    }
  }
}

export async function syncHistory() {
  const api = new TransactionSearchController(sdk());
  const found = new Map<string, TransactionDetails>();

  // Fetch everything first; the database is written only after every request succeeded.
  const now = Date.now();
  for (let w = 0; w < WINDOWS; w++) await fetchRange(api, now - (w + 1) * 30 * DAY, now - w * 30 * DAY, found);

  const codes: Record<string, number> = {};
  const rows: ReturnType<typeof toRow>[] = [];
  let seen = 0, notPaid = 0;
  for (const t of found.values()) {
    const code = t.transactionInfo?.transactionEventCode ?? '?';
    codes[code] = (codes[code] ?? 0) + 1;
    if (!PAYOUT_CODES.includes(code)) continue;
    seen++;
    if (t.transactionInfo?.transactionStatus !== PAID_STATUS) { notPaid++; continue; }
    const r = toRow(t);
    if (r.txnId) rows.push(r);
  }

  // Each sync replaces the imported rows, so payouts that later reverse or return drop out.
  const insert = db().prepare(`INSERT OR IGNORE INTO history (date, name, email, amount, currency, invoice, source, txn_id)
    VALUES (?, ?, ?, ?, ?, ?, 'paypal', ?)`);
  db().exec('BEGIN');
  try {
    db().prepare("DELETE FROM history WHERE source = 'paypal'").run();
    for (const r of rows) insert.run(r.date, r.name, r.email, r.amount, r.currency, r.invoice, r.txnId);
    db().exec('COMMIT');
  } catch (e) {
    db().exec('ROLLBACK'); // never leave a transaction open on the shared connection
    throw e;
  }

  const at = new Date().toISOString();
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('history_synced_at', ?)").run(at);
  const unknownRecipient = rows.filter(r => !r.email).length;
  const result = { seen, imported: rows.length, notPaid, unknownRecipient, codes, syncedAt: at };
  console.log('history sync', result);
  return result;
}

export function historyStatus() {
  const counts = db().prepare('SELECT source, COUNT(*) AS n FROM history GROUP BY source').all() as { source: string; n: number }[];
  const synced = db().prepare("SELECT value FROM meta WHERE key = 'history_synced_at'").get() as { value: string } | undefined;
  return { counts: Object.fromEntries(counts.map(c => [c.source, c.n])), syncedAt: synced?.value ?? null };
}
