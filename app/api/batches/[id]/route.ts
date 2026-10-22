import { applyItemUpdate, getBatch, getLines, getPayouts, isResolved, loadHistory, setPayoutStatus, FINAL_BATCH } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import { paypal } from '@/lib/paypal';
import { suggestEmail } from '@/lib/facts';

// Hours an item may stay unclaimed before the page nudges the owner. Set low (e.g. 0.05) for demos.
const NUDGE_HOURS = Number(process.env.UNCLAIMED_NUDGE_HOURS ?? 72) || 72;

// Batch with lines and its PayPal batches. Unfinished PayPal batches are refreshed here (the polling path).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const batch = getBatch(id);
  if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });

  for (const p of getPayouts(id).filter(p => !FINAL_BATCH.includes(p.status ?? ''))) {
    try {
      const pp = await paypal(`/v1/payments/payouts/${p.paypal_batch_id}`);
      setPayoutStatus(p.paypal_batch_id, pp.batch_header.batch_status);
      for (const it of pp.items ?? []) {
        applyItemUpdate({
          lineId: Number(it.payout_item.sender_item_id), itemId: it.payout_item_id, status: it.transaction_status,
          error: it.errors?.message ?? null, txnId: it.transaction_id, payoutBatchId: p.paypal_batch_id,
        });
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
    const history = loadHistory();
    const invoices = JSON.parse(batch.invoices ?? '[]');
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
