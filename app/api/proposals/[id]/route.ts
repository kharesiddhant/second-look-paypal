import { db, type Line } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import { cancelOrResend } from '@/lib/payouts';

type Proposal = { id: number; line_id: number; action: 'resend' | 'cancel' | 'wait' | 'needs_email'; email: string | null; status: string };

// The owner approves or dismisses an agent proposal. Approving runs the same code as the owner's own buttons.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const { decision, email } = await req.json();
  const p = db().prepare('SELECT * FROM proposals WHERE id = ?').get(Number(id)) as Proposal | undefined;
  if (!p) return Response.json({ error: 'Not found' }, { status: 404 });
  if (p.status !== 'open') return Response.json({ error: `Already ${p.status}` }, { status: 409 });
  const close = (status: string, result: string | null = null) =>
    db().prepare('UPDATE proposals SET status = ?, result = ? WHERE id = ?').run(status, result, p.id);

  if (decision === 'dismiss') { close('dismissed'); return Response.json({ ok: true }); }
  if (decision !== 'approve') return Response.json({ error: 'Unknown decision' }, { status: 400 });
  if (p.action === 'wait') { close('done', 'Acknowledged'); return Response.json({ ok: true }); }

  const line = db().prepare('SELECT * FROM lines WHERE id = ?').get(p.line_id) as Line | undefined;
  if (!line) return Response.json({ error: 'Line not found' }, { status: 404 });
  // needs_email: the owner supplies the new address (as with their own Resend button); the usual checks apply.
  const to = p.action === 'needs_email' ? String(email ?? '').trim() : p.email ?? undefined;
  const r = await cancelOrResend(line, p.action === 'cancel' ? 'cancel' : 'resend', to);
  if (!r.ok) {
    // A typo in the owner's email keeps the proposal open; anything else closes it as failed.
    if (p.action !== 'needs_email' || r.status !== 400) close('failed', r.error);
    return Response.json({ error: r.error }, { status: r.status });
  }
  close('done', p.action === 'cancel' ? 'Cancelled' : `Resent to ${to}`);
  return Response.json({ ok: true });
}
