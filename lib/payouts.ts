// Cancel or resend a payout that did not reach its recipient. Used by the owner's buttons and by approved
// agent proposals, so both run exactly the same checks. Nothing here runs without an owner click.
import { applyItemUpdate, db, linkSend, setPayoutStatus, type Line } from './db';
import { paypal, PayPalError } from './paypal';

export type Outcome = { ok: true } | { ok: false; error: string; status: number };
const fail = (error: string, status: number): Outcome => ({ ok: false, error, status });

// Payouts that never reached anyone and can go to a corrected address without a cancel first.
export const RESENDABLE = ['RETURNED', 'FAILED', 'BLOCKED'];

export async function cancelOrResend(line: Line, action: 'cancel' | 'resend', email?: string): Promise<Outcome> {
  const to = String(email ?? '').trim();
  if (action === 'resend') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail('Enter a valid email', 400);
    if (to.toLowerCase() === line.email.toLowerCase()) return fail('Same email as the payout that did not arrive', 400);
    if (db().prepare('SELECT 1 FROM lines WHERE resend_of = ?').get(line.id)) return fail('Already resent', 409);
  }

  // Cancel first while unclaimed. If the recipient claimed it meanwhile, cancel fails and nothing is resent.
  if (line.status === 'UNCLAIMED' && line.payout_item_id && line.paypal_batch_id) {
    try {
      const r = await paypal(`/v1/payments/payouts-item/${line.payout_item_id}/cancel`, {});
      applyItemUpdate({
        lineId: line.id, itemId: line.payout_item_id, status: r.transaction_status, error: r.errors?.message ?? null,
        txnId: r.transaction_id, payoutBatchId: line.paypal_batch_id,
      });
      if (r.transaction_status !== 'RETURNED') return fail(`Cancel returned ${r.transaction_status}; nothing resent`, 409);
    } catch (e) {
      return fail(`Cancel failed: ${(e as Error).message}. Nothing resent.`, 502);
    }
  } else if (!(action === 'resend' && RESENDABLE.includes(line.status ?? ''))) {
    return fail(`Only unclaimed payouts can be cancelled (status ${line.status})`, 409);
  }
  if (action === 'cancel') return { ok: true };

  // Resend: a new line in the same batch, linked to the original. Owner-confirmed, not AI-reviewed.
  // Its sender_batch_id is fixed per original line, so a retry after an unclear answer cannot pay twice.
  const ref = `${line.batch_id}-resend-${line.id}`;
  const flags = [{ type: 'resend', reason: `Resent by the owner after line ${line.line} did not arrive; not AI-reviewed.`, evidence: `was ${line.email}` }];
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
    return { ok: true };
  } catch (e) {
    const err = e instanceof PayPalError ? e : new PayPalError((e as Error).message, 'unknown');
    if (err.kind === 'duplicate' && err.existingBatchId) {
      linkSend(ref, err.existingBatchId, line.batch_id, line.currency);
      return { ok: true };
    }
    if (err.kind === 'rejected') {
      db().prepare('DELETE FROM lines WHERE id = ?').run(newId); // nothing was created; the owner can try again
      return fail(`Resend failed: ${err.message}`, 502);
    }
    // Unclear: keep the line as "sending"; Retry on the batch repeats this exact send safely.
    return fail('No clear answer from PayPal for the resend. It may have gone out. Press Retry: PayPal ignores a repeat of the same send.', 502);
  }
}
