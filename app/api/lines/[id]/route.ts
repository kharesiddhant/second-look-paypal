import { db, getBatch, type Line } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import type { Fix } from '@/lib/review';

// Owner actions on one line: apply the suggested fix, override a block with a reason, tick a review line,
// or drop any line by hand (and undo that before sending).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const { action, reason } = await req.json();
  const line = db().prepare('SELECT * FROM lines WHERE id = ?').get(Number(id)) as Line | undefined;
  if (!line) return Response.json({ error: 'Not found' }, { status: 404 });
  // A line being sent (send_ref set) or already sent can no longer change.
  if (getBatch(line.batch_id)?.status !== 'review' || line.paypal_batch_id || line.send_ref) {
    return Response.json({ error: 'Line already sent' }, { status: 409 });
  }

  if (action === 'fix') {
    if (!line.fix) return Response.json({ error: 'No suggested fix' }, { status: 400 });
    const fix = JSON.parse(line.fix) as Fix;
    if (fix.action === 'drop') {
      db().prepare('UPDATE lines SET dropped = 1, fix_applied = 1 WHERE id = ?').run(line.id);
    } else {
      for (const c of fix.changes) {
        const col = { email: 'email', amount: 'amount', currency: 'currency' }[c.field]; // whitelist, never raw input
        if (!col) return Response.json({ error: `Unknown field ${c.field}` }, { status: 400 });
        db().prepare(`UPDATE lines SET ${col} = ? WHERE id = ?`).run(c.value, line.id);
      }
      db().prepare('UPDATE lines SET fix_applied = 1 WHERE id = ?').run(line.id);
    }
  } else if (action === 'override') {
    if (line.verdict !== 'block') return Response.json({ error: 'Only block lines need an override' }, { status: 400 });
    if (!reason?.trim()) return Response.json({ error: 'Override needs a reason' }, { status: 400 });
    db().prepare('UPDATE lines SET override_reason = ? WHERE id = ?').run(String(reason).trim().slice(0, 500), line.id);
  } else if (action === 'drop') {
    db().prepare('UPDATE lines SET dropped = 1 WHERE id = ?').run(line.id);
  } else if (action === 'undrop') {
    // Undoing a drop that came from the suggested fix also un-applies that fix, so the line needs resolving again.
    const fixWasDrop = !!line.fix && (JSON.parse(line.fix) as Fix).action === 'drop';
    db().prepare('UPDATE lines SET dropped = 0, fix_applied = ? WHERE id = ?').run(fixWasDrop ? 0 : line.fix_applied, line.id);
  } else if (action === 'tick') {
    db().prepare('UPDATE lines SET ticked = 1 - ticked WHERE id = ?').run(line.id);
  } else {
    return Response.json({ error: 'Unknown action' }, { status: 400 });
  }
  return Response.json({ ok: true });
}
