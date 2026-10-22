import { db, setItemStatus, type Line } from '@/lib/db';
import { paypal } from '@/lib/paypal';

// Owner actions after sending: cancel an unclaimed payout, or cancel and resend to a corrected email.
// Nothing here runs on its own; every call is an owner click.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { action, email } = await req.json();
  const line = db().prepare('SELECT * FROM lines WHERE id = ?').get(Number(id)) as Line | undefined;
  if (!line) return Response.json({ error: 'Not found' }, { status: 404 });
  if (action !== 'cancel' && action !== 'resend') return Response.json({ error: 'Unknown action' }, { status: 400 });

  const to = String(email ?? '').trim();
  if (action === 'resend') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return Response.json({ error: 'Enter a valid email' }, { status: 400 });
    if (to.toLowerCase() === line.email.toLowerCase()) return Response.json({ error: 'Same email as the unclaimed payout' }, { status: 400 });
    if (db().prepare('SELECT 1 FROM lines WHERE resend_of = ?').get(line.id)) return Response.json({ error: 'Already resent' }, { status: 409 });
  }

  // Cancel first while unclaimed. If the recipient claimed it meanwhile, cancel fails and nothing is resent.
  if (line.status === 'UNCLAIMED' && line.payout_item_id) {
    try {
      const r = await paypal(`/v1/payments/payouts-item/${line.payout_item_id}/cancel`, {});
      setItemStatus(line.id, line.payout_item_id, r.transaction_status, r.errors?.message ?? null);
      if (r.transaction_status !== 'RETURNED') {
        return Response.json({ error: `Cancel returned ${r.transaction_status}; nothing resent` }, { status: 409 });
      }
    } catch (e) {
      return Response.json({ error: `Cancel failed: ${(e as Error).message}` }, { status: 502 });
    }
  } else if (!(action === 'resend' && line.status === 'RETURNED')) {
    return Response.json({ error: `Only unclaimed payouts can be cancelled (status ${line.status})` }, { status: 409 });
  }
  if (action === 'cancel') return Response.json({ ok: true });

  // Resend: a new line in the same batch, linked to the original. Owner-confirmed, not AI-reviewed.
  const flags = [{ type: 'resend', reason: `Resent by the owner after line ${line.line} went unclaimed; not AI-reviewed.`, evidence: `was ${line.email}` }];
  const ins = db().prepare(`INSERT INTO lines (batch_id, line, name, email, amount, currency, invoice, note, verdict, flags, resend_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`)
    .run(line.batch_id, line.line, line.name, to, line.amount, line.currency, line.invoice, line.note, JSON.stringify(flags), line.id);
  const newId = Number(ins.lastInsertRowid);
  try {
    const pp = await paypal('/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: `${line.batch_id}-resend-${newId}`, email_subject: 'You have a payment' },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: Number(line.amount).toFixed(2), currency: line.currency },
        receiver: to,
        sender_item_id: String(newId),
        note: [line.invoice, line.note].filter(Boolean).join(' · ') || undefined,
      }],
    });
    const ppId = pp.batch_header.payout_batch_id;
    db().prepare('INSERT INTO payouts VALUES (?, ?, ?, ?)').run(ppId, line.batch_id, line.currency, pp.batch_header.batch_status);
    db().prepare('UPDATE lines SET paypal_batch_id = ? WHERE id = ?').run(ppId, newId);
    return Response.json({ ok: true });
  } catch (e) {
    db().prepare('DELETE FROM lines WHERE id = ?').run(newId); // nothing was sent; owner can retry
    return Response.json({ error: `Resend failed: ${(e as Error).message}` }, { status: 502 });
  }
}
