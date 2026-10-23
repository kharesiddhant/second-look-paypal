import { db, type Line } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import { cancelOrResend } from '@/lib/payouts';

// Owner actions after sending: cancel an unclaimed payout, or resend to a corrected email.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const { action, email } = await req.json();
  const line = db().prepare('SELECT * FROM lines WHERE id = ?').get(Number(id)) as Line | undefined;
  if (!line) return Response.json({ error: 'Not found' }, { status: 404 });
  if (action !== 'cancel' && action !== 'resend') return Response.json({ error: 'Unknown action' }, { status: 400 });
  const r = await cancelOrResend(line, action, email);
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
