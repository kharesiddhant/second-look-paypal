import { db } from '@/lib/db';
import { parseCsv } from '@/lib/csv';
import { reviewBatch, type Review } from '@/lib/review';

// Upload a payout CSV: store lines, run the review, store verdicts.
export async function POST(req: Request) {
  const csv = await req.text();
  const rows = parseCsv(csv);
  if (!rows.length) return Response.json({ error: 'CSV has no rows' }, { status: 400 });

  // Owner's rule: if the AI fails, the batch still loads and every line needs a tick.
  let review: Review;
  let unreviewed = 'The review returned nothing for this line.';
  try {
    review = await reviewBatch(csv);
  } catch (e) {
    console.error('review failed', e);
    unreviewed = 'AI review unavailable. Check this line yourself.';
    review = { lines: [], summary: `AI review unavailable: ${(e as Error).message}` };
  }
  const byLine = new Map(review.lines.map(r => [r.line, r]));
  const id = `sl-${Date.now()}`;

  db().prepare('INSERT INTO batches (id, created_at, status, summary) VALUES (?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'review', review.summary);
  const insert = db().prepare(`INSERT INTO lines
    (batch_id, line, name, email, amount, currency, invoice, note, verdict, flags, fix, fix_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    const n = Number(r.line);
    // A line the review missed is never auto-ok.
    const rv = byLine.get(n) ?? { verdict: 'review', flags: [{ type: 'unreviewed', reason: unreviewed, evidence: '' }], fix: null, fix_note: null };
    insert.run(id, n, r.name, r.email, r.amount, r.currency, r.invoice, r.note ?? '',
      rv.verdict, JSON.stringify(rv.flags), rv.fix ? JSON.stringify(rv.fix) : null, rv.fix_note);
  }
  return Response.json({ id });
}
