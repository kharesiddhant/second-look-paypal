import { applyItemUpdate, db, linkSend, setPayoutStatus } from '@/lib/db';
import { verifyWebhook } from '@/lib/paypal';

// PayPal payout webhooks. Not behind the owner login (PayPal can't sign in); the signature is verified instead.
// Updates apply only to lines that belong to the PayPal batch named in the event (see applyItemUpdate).
export async function POST(req: Request) {
  const event = await req.json().catch(() => null);
  // Cheap checks first, so junk requests don't each cost a PayPal verification call.
  if (!event?.id || !String(event.event_type ?? '').startsWith('PAYMENT.PAYOUTS') || !req.headers.get('paypal-transmission-sig')) {
    return Response.json({ error: 'Not a payout webhook' }, { status: 400 });
  }
  if (db().prepare('SELECT 1 FROM events WHERE id = ?').get(event.id)) return Response.json({ ok: true, duplicate: true });
  if (!(await verifyWebhook(req.headers, event))) return Response.json({ error: 'Bad signature' }, { status: 400 });

  const r = event.resource;
  if (event.resource_type === 'payouts_item') {
    applyItemUpdate({
      lineId: Number(r.payout_item?.sender_item_id), itemId: r.payout_item_id, status: r.transaction_status,
      error: r.errors?.message ?? null, txnId: r.transaction_id, payoutBatchId: r.payout_batch_id, senderBatchId: r.sender_batch_id,
    });
  } else if (event.resource_type === 'payouts') {
    const payoutBatchId = r.batch_header.payout_batch_id;
    const ref = r.batch_header.sender_batch_header?.sender_batch_id;
    const known = db().prepare('SELECT 1 FROM payouts WHERE paypal_batch_id = ?').get(payoutBatchId);
    if (!known && ref) {
      // A send whose reply we never saw: link it now.
      const l = db().prepare('SELECT batch_id, currency FROM lines WHERE send_ref = ? LIMIT 1').get(ref) as { batch_id: string; currency: string } | undefined;
      if (l) linkSend(ref, payoutBatchId, l.batch_id, l.currency);
    }
    setPayoutStatus(payoutBatchId, r.batch_header.batch_status);
  }
  // Recorded after processing: if processing fails, PayPal retries, and processing is safe to repeat.
  db().prepare('INSERT OR IGNORE INTO events (id, type, received_at) VALUES (?, ?, ?)')
    .run(event.id, event.event_type, new Date().toISOString());
  return Response.json({ ok: true });
}
