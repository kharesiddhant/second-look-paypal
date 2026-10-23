import { requireOwner } from '@/lib/auth';
import { getBatch } from '@/lib/db';
import { startFollowUp } from '@/lib/agent';

// The owner's "Follow up" button on a sent batch.
export async function POST(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { batchId } = await req.json();
  const batch = getBatch(String(batchId ?? ''));
  if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });
  if (batch.status !== 'sent') return Response.json({ error: 'Follow-up is for sent batches' }, { status: 409 });
  return Response.json({ runId: startFollowUp(batch.id) });
}
