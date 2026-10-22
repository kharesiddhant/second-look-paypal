import { db, getBatch, getLines, isResolved, linkSend, markSentIfDone, setPayoutStatus, type Line } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import { paypal, PayPalError } from '@/lib/paypal';

// Batch approve = send, and also "retry" for sends that got no clear answer from PayPal.
// PayPal allows one currency per batch, so new lines are split into one PayPal batch per currency.
//
// Double-payment safety: each line is claimed with a sender_batch_id (send_ref) before PayPal is called.
// PayPal refuses a second batch with the same sender_batch_id and names the existing one, so a retry under
// the same send_ref either creates the batch or tells us it already exists. A new send_ref is only used
// after PayPal clearly rejected the earlier attempt.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const batch = getBatch(id);
  if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });

  const lines = getLines(id);
  const unsent = lines.filter(l => !l.dropped && !l.paypal_batch_id);
  if (!unsent.length) return Response.json({ error: 'Nothing left to send' }, { status: 409 });

  // New lines need the owner's approval, re-checked here rather than trusted from the page.
  const fresh = unsent.filter(l => !l.send_ref);
  if (fresh.length) {
    const open = lines.filter(l => !isResolved(l)).map(l => l.line);
    if (open.length) return Response.json({ error: `Unresolved lines: ${open.join(', ')}` }, { status: 400 });
  }

  // Claim fresh lines before the first await, so a concurrent request sees them claimed and retries the same IDs.
  const now = new Date().toISOString();
  const stamp = now.replace(/\D/g, '');
  const claim = db().prepare('UPDATE lines SET send_ref = ?, sent_at = ? WHERE id = ?');
  for (const l of fresh) {
    l.send_ref = `${id}-${l.currency}-${stamp}`;
    claim.run(l.send_ref, now, l.id);
  }

  const groups = new Map<string, Line[]>();
  for (const l of unsent) groups.set(l.send_ref!, [...(groups.get(l.send_ref!) ?? []), l]);

  const rejected: string[] = [];
  const unknown: string[] = [];
  for (const [ref, group] of groups) {
    const currency = group[0].currency;
    try {
      const pp = await paypal('/v1/payments/payouts', {
        sender_batch_header: { sender_batch_id: ref, email_subject: 'You have a payment' },
        items: group.map(l => ({
          recipient_type: 'EMAIL',
          amount: { value: Number(l.amount).toFixed(2), currency },
          receiver: l.email,
          sender_item_id: String(l.id),
          note: [l.invoice, l.note].filter(Boolean).join(' · ') || undefined,
        })),
      });
      linkSend(ref, pp.batch_header.payout_batch_id, id, currency);
      setPayoutStatus(pp.batch_header.payout_batch_id, pp.batch_header.batch_status);
    } catch (e) {
      const err = e instanceof PayPalError ? e : new PayPalError((e as Error).message, 'unknown');
      if (err.kind === 'duplicate' && err.existingBatchId) {
        linkSend(ref, err.existingBatchId, id, currency); // an earlier attempt did go through
      } else if (err.kind === 'rejected') {
        db().prepare('UPDATE lines SET send_ref = NULL, sent_at = NULL WHERE send_ref = ?').run(ref); // nothing was created
        rejected.push(`${currency}: ${err.message}`);
      } else {
        unknown.push(currency); // keep the claim: the payout may exist, and a retry under the same ID is safe
        console.error('payout send unclear', ref, err.message);
      }
    }
  }

  markSentIfDone(id);
  const messages = [
    rejected.length && `Not sent. ${rejected.join(' | ')}`,
    unknown.length && `No clear answer from PayPal for ${unknown.join(', ')}. The payout may have gone out. Press Retry: PayPal ignores a repeat of the same send.`,
  ].filter(Boolean);
  if (messages.length) return Response.json({ error: messages.join('\n') }, { status: 502 });
  return Response.json({ ok: true });
}
