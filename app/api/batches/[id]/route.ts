import { db, getBatch, getLines, getPayouts, isResolved, FINAL_BATCH } from '@/lib/db';
import { paypal } from '@/lib/paypal';

// Batch with lines and its PayPal batches. Unfinished PayPal batches are refreshed here (the polling path).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = getBatch(id);
  if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });

  for (const p of getPayouts(id).filter(p => !FINAL_BATCH.includes(p.status ?? ''))) {
    try {
      const pp = await paypal(`/v1/payments/payouts/${p.paypal_batch_id}`);
      db().prepare('UPDATE payouts SET status = ? WHERE paypal_batch_id = ?').run(pp.batch_header.batch_status, p.paypal_batch_id);
      const upd = db().prepare('UPDATE lines SET payout_item_id = ?, status = ?, error = ? WHERE id = ?');
      for (const it of pp.items ?? []) {
        upd.run(it.payout_item_id, it.transaction_status, it.errors?.message ?? null, Number(it.payout_item.sender_item_id));
      }
    } catch (e) {
      console.error('poll failed', p.paypal_batch_id, e);
    }
  }

  const lines = getLines(id);
  return Response.json({
    batch,
    lines,
    payouts: getPayouts(id),
    canSend: batch.status === 'review' && lines.every(isResolved),
  });
}
