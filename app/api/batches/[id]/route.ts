import { readFileSync } from 'node:fs';
import { db, getBatch, getLines, getPayouts, isResolved, setItemStatus, FINAL_BATCH } from '@/lib/db';
import { paypal } from '@/lib/paypal';
import { suggestEmail } from '@/lib/facts';

// Hours an item may stay unclaimed before the page nudges the owner. Set low (e.g. 0.05) for demos.
const NUDGE_HOURS = Number(process.env.UNCLAIMED_NUDGE_HOURS ?? 72);

// Batch with lines and its PayPal batches. Unfinished PayPal batches are refreshed here (the polling path).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = getBatch(id);
  if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });

  for (const p of getPayouts(id).filter(p => !FINAL_BATCH.includes(p.status ?? ''))) {
    try {
      const pp = await paypal(`/v1/payments/payouts/${p.paypal_batch_id}`);
      db().prepare('UPDATE payouts SET status = ? WHERE paypal_batch_id = ?').run(pp.batch_header.batch_status, p.paypal_batch_id);
      for (const it of pp.items ?? []) {
        setItemStatus(Number(it.payout_item.sender_item_id), it.payout_item_id, it.transaction_status, it.errors?.message ?? null);
      }
    } catch (e) {
      console.error('poll failed', p.paypal_batch_id, e);
    }
  }

  const lines = getLines(id);
  // Suggested resend emails for unclaimed or returned lines that were not resent yet.
  const resent = new Set(lines.map(l => l.resend_of).filter(Boolean));
  const open = lines.filter(l => (l.status === 'UNCLAIMED' || l.status === 'RETURNED') && !resent.has(l.id));
  const suggestions: Record<number, { email: string; source: string } | null> = {};
  if (open.length) {
    const history = db().prepare('SELECT * FROM history').all() as Record<string, string>[];
    const invoices = readFileSync('day1-test/invoices.txt', 'utf8');
    for (const l of open) suggestions[l.id] = suggestEmail(l, history, invoices);
  }

  return Response.json({
    batch,
    lines,
    payouts: getPayouts(id),
    canSend: batch.status === 'review' && lines.every(isResolved),
    suggestions,
    resent: [...resent],
    nudgeHours: NUDGE_HOURS,
  });
}
