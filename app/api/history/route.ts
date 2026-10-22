import { historyStatus, syncHistory } from '@/lib/history';
import { requireOwner } from '@/lib/auth';

// History counts by source and last sync time.
export async function GET(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  return Response.json(historyStatus());
}

// Owner's "Sync history from PayPal" button.
export async function POST(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  try {
    const result = await syncHistory();
    return Response.json({ ...result, ...historyStatus() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
