const BASE = 'https://api-m.sandbox.paypal.com';
const TIMEOUT = 30_000;
let cached: { token: string; expires: number } | null = null;

// How a failed PayPal call ended, which decides whether a retry is safe:
// 'rejected'  PayPal refused the request; nothing was created.
// 'duplicate' a payout batch with this sender_batch_id already exists; existingBatchId names it.
// 'unknown'   no clear answer (network error, timeout, 5xx). The payout may exist; only a retry with the
//             same sender_batch_id is safe, because PayPal refuses a second batch with that ID.
export class PayPalError extends Error {
  constructor(message: string, readonly kind: 'rejected' | 'duplicate' | 'unknown', readonly existingBatchId?: string) {
    super(message);
  }
}

async function token() {
  if (cached && Date.now() < cached.expires) return cached.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  try {
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error_description ?? String(res.status));
    cached = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
    return cached.token;
  } catch (e) {
    throw new PayPalError(`PayPal sign-in failed: ${(e as Error).message}`, 'rejected'); // nothing was sent yet
  }
}

type Detail = { field?: string; issue?: string; link?: { href: string; rel: string }[] };

export async function paypal(path: string, body?: unknown) {
  const auth = await token();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    throw new PayPalError(`No answer from PayPal: ${(e as Error).message}`, 'unknown');
  }
  const text = await res.text();
  let j: { name?: string; message?: string; details?: Detail[] } & Record<string, unknown> = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* non-JSON body, e.g. a gateway error page */ }
  if (res.ok) return j as any;

  if (res.status === 401) cached = null; // expired or revoked token: fetch a new one next time
  const details = j.details ?? [];
  const message = `${j.name ?? res.status}: ${j.message ?? 'PayPal error'}${
    details.length ? ` (${details.map(d => `${d.field}: ${d.issue}`).join('; ')})` : ''}`;
  // Seen in sandbox: USER_BUSINESS_ERROR, field SENDER_BATCH_ID, with a link to the existing batch.
  const dup = details.find(d => d.field === 'SENDER_BATCH_ID');
  if (dup) {
    const href = dup.link?.find(l => l.rel === 'self')?.href ?? '';
    throw new PayPalError(message, 'duplicate', href.split('/').pop() || undefined);
  }
  throw new PayPalError(message, res.status >= 500 || res.status === 408 ? 'unknown' : 'rejected');
}

export async function verifyWebhook(headers: Headers, event: unknown) {
  const r = await paypal('/v1/notifications/verify-webhook-signature', {
    auth_algo: headers.get('paypal-auth-algo'),
    cert_url: headers.get('paypal-cert-url'),
    transmission_id: headers.get('paypal-transmission-id'),
    transmission_sig: headers.get('paypal-transmission-sig'),
    transmission_time: headers.get('paypal-transmission-time'),
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  return r.verification_status === 'SUCCESS';
}
