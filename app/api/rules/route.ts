import { demoMode, getRules, setRules } from '@/lib/db';
import { requireOwner } from '@/lib/auth';

// The owner's rules, plus whether this server offers the demo files.
export async function GET(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  return Response.json({ rules: getRules(), demo: demoMode() });
}

// Owner saves their rules once; every later review uses them.
export async function PUT(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { rules } = await req.json();
  const text = String(rules ?? '').trim();
  if (!text) return Response.json({ error: 'Rules cannot be empty' }, { status: 400 });
  if (text.length > 4000) return Response.json({ error: 'Rules are limited to 4,000 characters' }, { status: 400 });
  setRules(text);
  return Response.json({ rules: text });
}
