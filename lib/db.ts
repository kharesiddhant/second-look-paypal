import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { parseCsv } from './csv';

// Opened on first use, not at import: next build loads routes in parallel workers.
let conn: DatabaseSync | null = null;
export function db() {
  if (conn) return conn;
  mkdirSync('data', { recursive: true });
  conn = new DatabaseSync('data/second-look.db');
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
`);
// Column added after the first schema; no-op on new databases.
try { db.exec('ALTER TABLE lines ADD COLUMN paypal_batch_id TEXT'); } catch {}

// Seed past payouts once, for the real review later.
const { n } = db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number };
if (n === 0) {
  const insert = db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of parseCsv(readFileSync('day1-test/history.csv', 'utf8'))) {
    insert.run(r.date, r.name, r.email, r.amount, r.currency, r.invoice);
  }
}
}

export type Line = {
  id: number; batch_id: string; line: number;
  name: string; email: string; amount: string; currency: string; invoice: string; note: string;
  verdict: 'ok' | 'review' | 'block'; flags: string; fix: string | null; fix_note: string | null;
  fix_applied: number; override_reason: string | null; ticked: number; dropped: number;
  payout_item_id: string | null; status: string | null; error: string | null; paypal_batch_id: string | null;
};

export type Batch = { id: string; created_at: string; status: 'review' | 'sent'; summary: string };
export type Payout = { paypal_batch_id: string; batch_id: string; currency: string; status: string | null };

export const getBatch = (id: string) =>
  db().prepare('SELECT * FROM batches WHERE id = ?').get(id) as Batch | undefined;

export const getPayouts = (batchId: string) =>
  db().prepare('SELECT * FROM payouts WHERE batch_id = ? ORDER BY currency').all(batchId) as Payout[];

export const FINAL_BATCH = ['SUCCESS', 'DENIED', 'CANCELED'];

export const getLines = (batchId: string) =>
  db().prepare('SELECT * FROM lines WHERE batch_id = ? ORDER BY line').all(batchId) as Line[];

// The owner's approval rule: block needs fix or override, review needs a tick.
export function isResolved(l: Line) {
  if (l.dropped || l.verdict === 'ok') return true;
  if (l.verdict === 'block') return !!l.fix_applied || !!l.override_reason;
  return !!l.ticked;
}
