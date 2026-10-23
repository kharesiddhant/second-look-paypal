import { requireOwner } from '@/lib/auth';
import { getRun, getSteps } from '@/lib/agent';

// One agent run with its steps, for the live log.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const run = getRun(Number(id));
  if (!run) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ run, steps: getSteps(run.id) });
}
