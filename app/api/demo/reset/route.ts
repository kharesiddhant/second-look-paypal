import { db, demoMode } from '@/lib/db';
import { requireOwner } from '@/lib/auth';

// Demo servers only: clears every batch, line, payout and imported PayPal history so the demo can run again
// without "already paid" on every line. Keeps the rules, the seed history and cached reviews.
export async function POST(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  if (!demoMode()) return Response.json({ error: 'Reset is only available when DEMO=1' }, { status: 400 });
  db().exec('BEGIN');
  try {
    db().exec(`DELETE FROM review_chunks; DELETE FROM proposals; DELETE FROM agent_steps; DELETE FROM agent_runs; DELETE FROM lines; DELETE FROM payouts; DELETE FROM batches; DELETE FROM events;
      DELETE FROM history WHERE source = 'paypal'; DELETE FROM meta WHERE key = 'history_synced_at';`);
    db().exec('COMMIT');
  } catch (e) {
    db().exec('ROLLBACK');
    throw e;
  }
  return Response.json({ ok: true });
}
