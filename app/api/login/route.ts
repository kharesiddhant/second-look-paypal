import { newSession, passwordMatches, SESSION_COOKIE } from '@/lib/auth';

const cookie = (value: string, maxAge: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

// Sign in with the shared password.
export async function POST(req: Request) {
  if (!process.env.APP_PASSWORD) return Response.json({ error: 'APP_PASSWORD is not set on the server' }, { status: 500 });
  const { password } = await req.json().catch(() => ({ password: '' }));
  if (!passwordMatches(String(password ?? ''))) {
    await new Promise(r => setTimeout(r, 500)); // slows down password guessing
    return Response.json({ error: 'Wrong password' }, { status: 401 });
  }
  const s = newSession();
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookie(s.value, s.maxAge) } });
}

// Sign out.
export async function DELETE() {
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookie('', 0) } });
}
