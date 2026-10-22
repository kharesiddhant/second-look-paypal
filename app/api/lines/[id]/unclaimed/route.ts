import { applyItemUpdate, db, linkSend, setPayoutStatus, type Line } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import { paypal, PayPalError } from '@/lib/paypal';

// Owner actions after sending: cancel an unclaimed payout, or cancel and resend to a corrected email.
// Nothing here runs on its own; every call is an owner click.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
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
  if (line.status === 'UNCLAIMED' && line.payout_item_id && line.paypal_batch_id) {
    try {
      const r = await paypal(`/v1/payments/payouts-item/${line.payout_item_id}/cancel`, {});
      applyItemUpdate({
        lineId: line.id, itemId: line.payout_item_id, status: r.transaction_status, error: r.errors?.message ?? null,
        txnId: r.transaction_id, payoutBatchId: line.paypal_batch_id,
      });
      if (r.transaction_status !== 'RETURNED') {
        return Response.json({ error: `Cancel returned ${r.transaction_status}; nothing resent` }, { status: 409 });
      }
    } catch (e) {
      return Response.json({ error: `Cancel failed: ${(e as Error).message}. Nothing resent.` }, { status: 502 });
    }
  } else if (!(action === 'resend' && line.status === 'RETURNED')) {
    return Response.json({ error: `Only unclaimed payouts can be cancelled (status ${line.status})` }, { status: 409 });
  }
  if (action === 'cancel') return Response.json({ ok: true });

  // Resend: a new line in the same batch, linked to the original. Owner-confirmed, not AI-reviewed.
  // Its sender_batch_id is fixed per original line, so a retry after an unclear answer cannot pay twice.
  const ref = `${line.batch_id}-resend-${line.id}`;
  const flags = [{ type: 'resend', reason: `Resent by the owner after line ${line.line} went unclaimed; not AI-reviewed.`, evidence: `was ${line.email}` }];
  const ins = db().prepare(`INSERT INTO lines (batch_id, line, name, email, amount, currency, invoice, note, verdict, flags, resend_of, send_ref, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)`)
    .run(line.batch_id, line.line, line.name, to, line.amount, line.currency, line.invoice, line.note,
      JSON.stringify(flags), line.id, ref, new Date().toISOString());
  const newId = Number(ins.lastInsertRowid);
  try {
    const pp = await paypal('/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: ref, email_subject: 'You have a payment' },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: Number(line.amount).toFixed(2), currency: line.currency },
        receiver: to,
        sender_item_id: String(newId),
        note: [line.invoice, line.note].filter(Boolean).join(' · ') || undefined,
      }],
    });
    linkSend(ref, pp.batch_header.payout_batch_id, line.batch_id, line.currency);
    setPayoutStatus(pp.batch_header.payout_batch_id, pp.batch_header.batch_status);
    return Response.json({ ok: true });
  } catch (e) {
    const err = e instanceof PayPalError ? e : new PayPalError((e as Error).message, 'unknown');
    if (err.kind === 'duplicate' && err.existingBatchId) {
      linkSend(ref, err.existingBatchId, line.batch_id, line.currency);
      return Response.json({ ok: true });
    }
    if (err.kind === 'rejected') {
      db().prepare('DELETE FROM lines WHERE id = ?').run(newId); // nothing was created; the owner can try again
      return Response.json({ error: `Resend failed: ${err.message}` }, { status: 502 });
    }
    // Unclear: keep the line as "sending"; Retry on the batch repeats this exact send safely.
    return Response.json({ error: 'No clear answer from PayPal for the resend. It may have gone out. Press Retry: PayPal ignores a repeat of the same send.' }, { status: 502 });
  }
}
