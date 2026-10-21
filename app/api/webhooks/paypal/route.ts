import { db } from '@/lib/db';
import { verifyWebhook } from '@/lib/paypal';

// PayPal payout webhooks. Verified, de-duplicated by event id, matched by sender_item_id (= our line id).
export async function POST(req: Request) {
  const event = await req.json();
  if (!(await verifyWebhook(req.headers, event))) {
    return Response.json({ error: 'Bad signature' }, { status: 400 });
  }

  const seen = db().prepare('INSERT OR IGNORE INTO events (id, type, received_at) VALUES (?, ?, ?)')
    .run(event.id, event.event_type, new Date().toISOString());
  if (seen.changes === 0) return Response.json({ ok: true, duplicate: true });

  const r = event.resource;
  if (event.resource_type === 'payouts_item') {
    db().prepare('UPDATE lines SET payout_item_id = ?, status = ?, error = ? WHERE id = ?')
      .run(r.payout_item_id, r.transaction_status, r.errors?.message ?? null, Number(r.payout_item.sender_item_id));
  } else if (event.resource_type === 'payouts') {
    db().prepare('UPDATE payouts SET status = ? WHERE paypal_batch_id = ?')
      .run(r.batch_header.batch_status, r.batch_header.payout_batch_id);
  }
  return Response.json({ ok: true });
}
