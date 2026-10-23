import { db, type Line } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import { cancelOrResend } from '@/lib/payouts';

type Proposal = { id: number; line_id: number; action: 'resend' | 'cancel' | 'wait'; email: string | null; status: string };

// The owner approves or dismisses an agent proposal. Approving runs the same code as the owner's own buttons.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const { decision } = await req.json();
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
  const r = await cancelOrResend(line, p.action, p.email ?? undefined);
  if (!r.ok) { close('failed', r.error); return Response.json({ error: r.error }, { status: r.status }); }
  close('done', p.action === 'resend' ? `Resent to ${p.email}` : 'Cancelled');
  return Response.json({ ok: true });
}
