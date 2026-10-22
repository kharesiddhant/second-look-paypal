import { historyStatus, syncHistory } from '@/lib/history';

// History counts by source and last sync time.
export async function GET() {
  return Response.json(historyStatus());
}

// Owner's "Sync history from PayPal" button.
export async function POST() {
  try {
    const result = await syncHistory();
    return Response.json({ ...result, ...historyStatus() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
