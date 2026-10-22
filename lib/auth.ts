// One shared password (APP_PASSWORD). Signing in sets a signed, HttpOnly cookie valid for 7 days.
// The cookie holds an expiry time and an HMAC of it keyed by the password, so changing the password ends every session.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'sl_session';
const WEEK = 7 * 24 * 3600;

const mac = (value: string, key: string) => createHmac('sha256', key).update(`second-look:${value}`).digest('base64url');

export function newSession() {
  const key = process.env.APP_PASSWORD;
  if (!key) throw new Error('APP_PASSWORD is not set');
  const exp = Math.floor(Date.now() / 1000) + WEEK;
  return { value: `${exp}.${mac(String(exp), key)}`, maxAge: WEEK };
}

// Fails closed: no APP_PASSWORD on the server means nobody is signed in.
export function validSession(cookie: string | undefined) {
  const key = process.env.APP_PASSWORD;
  if (!key || !cookie) return false;
  const [exp, sig] = cookie.split('.');
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
  const want = Buffer.from(mac(exp, key)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function passwordMatches(input: string) {
  const key = process.env.APP_PASSWORD;
  if (!key) return false;
  const digest = (s: string) => createHmac('sha256', 'second-look-password').update(s).digest();
  return timingSafeEqual(digest(input), digest(key));
}

// Every API route except login and the PayPal webhook calls this first.
// proxy.ts only redirects signed-out page visits; it is not the security boundary.
export function requireOwner(req: Request): Response | null {
  const cookie = req.headers.get('cookie')?.split(/;\s*/)
    .find(c => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return validSession(cookie) ? null : Response.json({ error: 'Not signed in' }, { status: 401 });
}
