import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCsv } from './csv';

// DB_PATH points at a persistent disk in production (Render paid plan); defaults to ./data locally.
const DB_PATH = process.env.DB_PATH ?? 'data/second-look.db';
export const demoMode = () => process.env.DEMO === '1';

// Opened on first use, not at import: next build loads routes in parallel workers.
let conn: DatabaseSync | null = null;
export function db() {
  if (conn) return conn;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  conn = new DatabaseSync(DB_PATH);
  init(conn);
  return conn;
}

function init(db: DatabaseSync) {
db.exec(`
CREATE TABLE IF NOT EXISTS history (date TEXT, name TEXT, email TEXT, amount TEXT, currency TEXT, invoice TEXT);
CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, created_at TEXT, status TEXT, summary TEXT);
-- PayPal allows one currency per payout batch, so one of our batches can map to several PayPal batches.
CREATE TABLE IF NOT EXISTS payouts (paypal_batch_id TEXT PRIMARY KEY, batch_id TEXT, currency TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, line INTEGER,
  name TEXT, email TEXT, amount TEXT, currency TEXT, invoice TEXT, note TEXT,
  verdict TEXT, flags TEXT, fix TEXT, fix_note TEXT,
  fix_applied INTEGER DEFAULT 0, override_reason TEXT, ticked INTEGER DEFAULT 0, dropped INTEGER DEFAULT 0,
  payout_item_id TEXT, status TEXT, error TEXT, paypal_batch_id TEXT
);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT, received_at TEXT);
-- Reviews keyed by a hash of everything sent to the model, so identical requests are not paid for twice.
CREATE TABLE IF NOT EXISTS reviews (key TEXT PRIMARY KEY, review TEXT, created_at TEXT);
-- Big batches are reviewed in 50-line chunks in the background (lib/chunks.ts).
CREATE TABLE IF NOT EXISTS review_chunks (
  batch_id TEXT, idx INTEGER, key TEXT, run_id TEXT, status TEXT, result TEXT, error TEXT, started_at TEXT,
  PRIMARY KEY (batch_id, idx)
);
`);
// Columns added after the first schema; no-ops on new databases.
try { db.exec('ALTER TABLE lines ADD COLUMN paypal_batch_id TEXT'); } catch {}
try { db.exec('ALTER TABLE lines ADD COLUMN resend_of INTEGER'); } catch {}
try { db.exec('ALTER TABLE lines ADD COLUMN unclaimed_since TEXT'); } catch {}
// send_ref: the sender_batch_id a line was sent under, set before calling PayPal. With no paypal_batch_id yet,
// the outcome is unknown and only a retry under the same send_ref is allowed.
try { db.exec('ALTER TABLE lines ADD COLUMN send_ref TEXT'); } catch {}
try { db.exec('ALTER TABLE lines ADD COLUMN sent_at TEXT'); } catch {}
try { db.exec('ALTER TABLE lines ADD COLUMN txn_id TEXT'); } catch {}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS lines_resend ON lines (resend_of)');
// History rows are labelled: 'seed' (demo file) or 'paypal' (imported via Transaction Search, keyed by transaction ID).
try { db.exec("ALTER TABLE history ADD COLUMN source TEXT DEFAULT 'seed'"); } catch {}
try { db.exec('ALTER TABLE history ADD COLUMN txn_id TEXT'); } catch {}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS history_txn ON history (txn_id)');
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
// Each batch keeps the invoices and notes it was reviewed with (JSON).
try { db.exec('ALTER TABLE batches ADD COLUMN invoices TEXT'); } catch {}
try { db.exec('ALTER TABLE batches ADD COLUMN notes TEXT'); } catch {}

// Demo history is seeded only when DEMO=1, so a real owner's database never holds fake payouts.
const { n } = db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number };
if (n === 0 && demoMode()) {
  const insert = db.prepare("INSERT INTO history (date, name, email, amount, currency, invoice, source) VALUES (?, ?, ?, ?, ?, ?, 'seed')");
  for (const r of parseCsv(readFileSync('day1-test/history.csv', 'utf8'))) {
    insert.run(r.date, r.name, r.email, r.amount, r.currency, r.invoice);
  }
}
// The 500-creator history behind the big demo, seeded once (also into demo databases created before it existed).
if (demoMode() && !db.prepare("SELECT 1 FROM meta WHERE key = 'seeded_big_demo'").get()) {
  const insert = db.prepare("INSERT INTO history (date, name, email, amount, currency, invoice, source) VALUES (?, ?, ?, ?, ?, ?, 'seed')");
  db.exec('BEGIN');
  for (const r of parseCsv(readFileSync('day1-test/big-history.csv', 'utf8'))) {
    insert.run(r.date, r.name, r.email, r.amount, r.currency, r.invoice);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('seeded_big_demo', '1')").run();
  db.exec('COMMIT');
}
}

export type Line = {
  id: number; batch_id: string; line: number;
  name: string; email: string; amount: string; currency: string; invoice: string; note: string;
  verdict: 'ok' | 'review' | 'block'; flags: string; fix: string | null; fix_note: string | null;
  fix_applied: number; override_reason: string | null; ticked: number; dropped: number;
  payout_item_id: string | null; status: string | null; error: string | null; paypal_batch_id: string | null;
  resend_of: number | null; unclaimed_since: string | null;
  send_ref: string | null; sent_at: string | null; txn_id: string | null;
};

export type Batch = {
  id: string; created_at: string; status: 'reviewing' | 'review' | 'sent'; summary: string;
  invoices: string | null; notes: string | null;
};

// Owner's rules: saved once, edited any time. The demo rules are the default only in demo mode.
export function getRules() {
  const r = db().prepare("SELECT value FROM meta WHERE key = 'rules'").get() as { value: string } | undefined;
  return r?.value ?? (demoMode() ? readFileSync('day1-test/rules.txt', 'utf8') : '');
}
export function setRules(rules: string) {
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('rules', ?)").run(rules);
}
export type Payout = { paypal_batch_id: string; batch_id: string; currency: string; status: string | null };

export const getBatch = (id: string) =>
  db().prepare('SELECT * FROM batches WHERE id = ?').get(id) as Batch | undefined;

export const getPayouts = (batchId: string) =>
  db().prepare('SELECT * FROM payouts WHERE batch_id = ? ORDER BY currency').all(batchId) as Payout[];

export const FINAL_BATCH = ['SUCCESS', 'DENIED', 'CANCELED'];

export const getLines = (batchId: string) =>
  db().prepare('SELECT * FROM lines WHERE batch_id = ? ORDER BY line, id').all(batchId) as Line[];

export const isPending = (l: Line) => !l.dropped && !!l.send_ref && !l.paypal_batch_id;

// Item statuses only move forward, so a late or repeated event never undoes a newer one.
const RANK: Record<string, number> = {
  PENDING: 1, ONHOLD: 1, UNCLAIMED: 2, SUCCESS: 3, FAILED: 4, RETURNED: 4, BLOCKED: 4, DENIED: 4, REFUNDED: 5, REVERSED: 5,
};

// One place for payout item updates, from polling and webhooks. The line must belong to the PayPal batch the
// update is about (or to the sender_batch_id we sent it under), so events from another environment or from
// an older database never touch a line with the same number.
export function applyItemUpdate(u: {
  lineId: number; itemId: string; status: string; error: string | null; txnId?: string;
  payoutBatchId: string; senderBatchId?: string;
}) {
  const line = db().prepare('SELECT * FROM lines WHERE id = ?').get(u.lineId) as Line | undefined;
  if (!line) return false;
  const ours = line.paypal_batch_id === u.payoutBatchId || (!!u.senderBatchId && line.send_ref === u.senderBatchId);
  if (!ours) return false;
  if (!line.paypal_batch_id && line.send_ref) linkSend(line.send_ref, u.payoutBatchId, line.batch_id, line.currency);
  if ((RANK[u.status] ?? 1) < (RANK[line.status ?? ''] ?? 0)) return true;
  db().prepare(`UPDATE lines SET payout_item_id = ?, status = ?, error = ?, txn_id = COALESCE(?, txn_id),
    unclaimed_since = CASE WHEN ? = 'UNCLAIMED' THEN COALESCE(unclaimed_since, ?) ELSE unclaimed_since END
    WHERE id = ?`).run(u.itemId, u.status, u.error, u.txnId ?? null, u.status, new Date().toISOString(), u.lineId);
  return true;
}

// Records which PayPal batch a send became: from PayPal's reply, its duplicate-ID error, a webhook or polling.
export function linkSend(sendRef: string, payoutBatchId: string, batchId: string, currency: string) {
  db().prepare('INSERT OR IGNORE INTO payouts (paypal_batch_id, batch_id, currency, status) VALUES (?, ?, ?, NULL)')
    .run(payoutBatchId, batchId, currency);
  db().prepare('UPDATE lines SET paypal_batch_id = ? WHERE send_ref = ? AND paypal_batch_id IS NULL').run(payoutBatchId, sendRef);
  markSentIfDone(batchId);
}

export function setPayoutStatus(payoutBatchId: string, status: string) {
  db().prepare('UPDATE payouts SET status = ? WHERE paypal_batch_id = ?').run(status, payoutBatchId);
}

export function markSentIfDone(batchId: string) {
  const { left } = db().prepare('SELECT COUNT(*) AS left FROM lines WHERE batch_id = ? AND dropped = 0 AND paypal_batch_id IS NULL')
    .get(batchId) as { left: number };
  if (left === 0) db().prepare("UPDATE batches SET status = 'sent' WHERE id = ?").run(batchId);
}

export type HistoryRow = Record<string, string> & { state?: 'paid' | 'in_flight' };
const IN_FLIGHT = ['PENDING', 'UNCLAIMED', 'ONHOLD'];

// History for the checks: seed and PayPal import (completed payouts), plus this app's own payouts.
// Owner's rule: own payouts count as already paid while successful or still in flight (sending, pending,
// unclaimed). Returned or failed ones do not. Imported rows that are one of our own payouts are skipped.
export function loadHistory(): HistoryRow[] {
  const own = db().prepare(`SELECT substr(COALESCE(l.sent_at, b.created_at), 1, 10) AS date, l.name, l.email, l.amount,
      l.currency, l.invoice, 'app' AS source, l.txn_id, l.status
    FROM lines l JOIN batches b ON b.id = l.batch_id
    WHERE l.dropped = 0 AND (l.send_ref IS NOT NULL OR l.paypal_batch_id IS NOT NULL)
      AND (l.status IS NULL OR l.status = 'SUCCESS' OR l.status IN (${IN_FLIGHT.map(() => '?').join(', ')}))`)
    .all(...IN_FLIGHT) as Record<string, string>[];
  const ownTxns = new Set(own.map(r => r.txn_id).filter(Boolean));
  const stored = (db().prepare('SELECT date, name, email, amount, currency, invoice, source, txn_id FROM history').all() as Record<string, string>[])
    .filter(h => !(h.source === 'paypal' && ownTxns.has(h.txn_id)))
    .map(h => ({ ...h, state: 'paid' }) as HistoryRow);
  const app = own.map(r => ({ ...r, state: r.status === 'SUCCESS' ? 'paid' : 'in_flight' }) as HistoryRow);
  return [...stored, ...app].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

// The owner's approval rule: block needs fix or override, review needs a tick.
export function isResolved(l: Line) {
  if (l.dropped || l.verdict === 'ok') return true;
  if (l.verdict === 'block') return !!l.fix_applied || !!l.override_reason;
  return !!l.ticked;
}
