import { db, getBatch, getLines, isResolved, type Line } from '@/lib/db';
import { paypal } from '@/lib/paypal';

// Batch approve = send. The approval rule is re-checked here, not trusted from the page.
// PayPal allows one currency per batch, so lines are split into one PayPal batch per currency.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = getBatch(id);
  if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });
  if (batch.status !== 'review') return Response.json({ error: 'Already sent' }, { status: 409 });

  const lines = getLines(id);
  const open = lines.filter(l => !isResolved(l)).map(l => l.line);
  if (open.length) return Response.json({ error: `Unresolved lines: ${open.join(', ')}` }, { status: 400 });
  if (lines.every(l => l.dropped)) return Response.json({ error: 'Every line was dropped' }, { status: 400 });

  // Lines already in a PayPal batch are skipped, so pressing send again retries only what failed.
  const groups = new Map<string, Line[]>();
  for (const l of lines.filter(l => !l.dropped && !l.paypal_batch_id)) {
    groups.set(l.currency, [...(groups.get(l.currency) ?? []), l]);
  }

  const errors: string[] = [];
  for (const [currency, group] of groups) {
    try {
      // sender_batch_id is unique per batch + currency, so PayPal itself rejects a double send.
      const pp = await paypal('/v1/payments/payouts', {
        sender_batch_header: { sender_batch_id: `${id}-${currency}`, email_subject: 'You have a payment' },
        items: group.map(l => ({
          recipient_type: 'EMAIL',
          amount: { value: Number(l.amount).toFixed(2), currency },
          receiver: l.email,
          sender_item_id: String(l.id),
          note: [l.invoice, l.note].filter(Boolean).join(' · ') || undefined,
        })),
      });
      const ppId = pp.batch_header.payout_batch_id;
      db().prepare('INSERT INTO payouts VALUES (?, ?, ?, ?)').run(ppId, id, currency, pp.batch_header.batch_status);
      const mark = db().prepare('UPDATE lines SET paypal_batch_id = ? WHERE id = ?');
      for (const l of group) mark.run(ppId, l.id);
    } catch (e) {
      errors.push(`${currency}: ${(e as Error).message}`);
    }
  }

  if (getLines(id).every(l => l.dropped || l.paypal_batch_id)) {
    db().prepare('UPDATE batches SET status = ? WHERE id = ?').run('sent', id);
  }
  if (errors.length) return Response.json({ error: `Not sent. ${errors.join(' | ')}` }, { status: 502 });
  return Response.json({ ok: true });
}
