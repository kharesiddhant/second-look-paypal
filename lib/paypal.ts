const BASE = 'https://api-m.sandbox.paypal.com';
let cached: { token: string; expires: number } | null = null;

async function token() {
  if (cached && Date.now() < cached.expires) return cached.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`PayPal auth failed: ${j.error_description ?? res.status}`);
  cached = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

export async function paypal(path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) {
    const details = (j.details ?? []).map((d: { field?: string; issue?: string }) => `${d.field}: ${d.issue}`).join('; ');
    throw new Error(`${j.name ?? res.status}: ${j.message ?? 'PayPal error'}${details ? ` (${details})` : ''}`);
  }
  return j;
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
