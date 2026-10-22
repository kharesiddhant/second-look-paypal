'use client';
// Unstyled on purpose: functional skeleton for the owner to design over.
import { useEffect, useState } from 'react';
import type { Batch, Line, Payout } from '@/lib/db';
import type { Fix, Flag } from '@/lib/review';

type Suggestion = { email: string; source: string } | null;
type Data = {
  batch: Batch; lines: Line[]; payouts: Payout[]; canSend: boolean;
  suggestions: Record<number, Suggestion>; resent: number[]; nudgeHours: number;
};
type BatchSummary = { id: string; created_at: string; status: string; lines: number; unclaimed: number | null; pending: number | null };

const FINAL = ['SUCCESS', 'DENIED', 'CANCELED'];

const fixLabel = (f: Fix) =>
  f.action === 'drop' ? 'Drop line' : `Set ${f.changes.map(c => `${c.field} to ${c.value}`).join(', ')}`;

// Sent to PayPal under a sender_batch_id, but PayPal's answer was never seen.
const isPending = (l: Line) => !l.dropped && !!l.send_ref && !l.paypal_batch_id;

// GET helper: a signed-out session sends the owner to the login page.
async function getJson(url: string) {
  const res = await fetch(url);
  if (res.status === 401) { window.location.href = '/login'; return null; }
  const j = await res.json();
  if (!res.ok) throw new Error(j.error);
  return j;
}

export default function Page() {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ counts: Record<string, number>; syncedAt: string | null } | null>(null);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);
  const [rules, setRules] = useState('');
  const [rulesSaved, setRulesSaved] = useState(true);
  const [demo, setDemo] = useState(false);
  const [recent, setRecent] = useState<BatchSummary[]>([]);

  useEffect(() => {
    getJson('/api/history').then(j => j && setHistory(j)).catch(e => setError(e.message));
    getJson('/api/rules').then(j => { if (j) { setRules(j.rules); setDemo(j.demo); } }).catch(e => setError(e.message));
    // A batch in the URL (?batch=…) reopens it, e.g. days later to cancel or resend an unclaimed payout.
    const fromUrl = new URLSearchParams(window.location.search).get('batch');
    if (fromUrl) openBatch(fromUrl);
  }, []);

  useEffect(() => {
    if (!data) getJson('/api/batches').then(j => j && setRecent(j.batches)).catch(() => {});
  }, [data]);

  async function syncHistory() {
    const j = await call('/api/history');
    if (!j) return;
    setHistory({ counts: j.counts, syncedAt: j.syncedAt });
    setSyncInfo(`Found ${j.seen} payouts: imported ${j.imported} completed${j.notPaid ? `, skipped ${j.notPaid} not completed (unclaimed or returned)` : ''}${j.unknownRecipient ? `, ${j.unknownRecipient} without recipient email` : ''}.`);
  }

  async function load(batchId = id) {
    if (!batchId) return;
    try {
      const j = await getJson(`/api/batches/${batchId}`);
      if (j) setData(j);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function openBatch(batchId: string | null) {
    setId(batchId);
    setData(null);
    setError(null);
    window.history.replaceState(null, '', batchId ? `/?batch=${batchId}` : '/');
    if (batchId) load(batchId);
  }

  async function call(url: string, body?: unknown, method = 'POST') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, body: body instanceof FormData ? body : JSON.stringify(body ?? {}) });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      return j;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Upload form (CSV + invoice files + notes) or the demo files; the review runs on the server.
  async function upload(form: FormData) {
    const j = await call('/api/batches', form);
    if (j) openBatch(j.id);
  }

  async function saveRules() {
    if (await call('/api/rules', { rules }, 'PUT')) setRulesSaved(true);
  }

  async function resetDemo() {
    if (!confirm('Reset the demo? This deletes every batch, payout record and imported PayPal history on this server. Rules and demo history stay.')) return;
    if (!(await call('/api/demo/reset'))) return;
    setRecent([]);
    setSyncInfo(null);
    getJson('/api/history').then(j => j && setHistory(j)).catch(() => {});
  }

  async function signOut() {
    await fetch('/api/login', { method: 'DELETE' });
    window.location.href = '/login';
  }

  async function act(lineId: number, action: string, reason?: string) {
    if (await call(`/api/lines/${lineId}`, { action, reason })) load();
  }

  async function unclaimed(lineId: number, action: 'cancel' | 'resend', email?: string) {
    await call(`/api/lines/${lineId}/unclaimed`, { action, email });
    load(); // reload even on error: an unclear resend leaves a "sending" line to retry
  }

  async function send() {
    await call(`/api/batches/${id}/send`);
    load(); // reload even on error: lines may now be sent or "sending"
  }

  // Polling: refresh every 5 s while any PayPal batch is not final.
  const sent = data?.batch.status === 'sent';
  const pendingLines = data?.lines.filter(isPending) ?? [];
  const pending = !!data?.payouts.some(p => !FINAL.includes(p.status ?? ''));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => load(), 5000);
    return () => clearInterval(t);
  }, [pending, id]);

  return (
    <main>
      <h1>Second Look</h1>
      <p><button onClick={signOut}>Sign out</button></p>

      <p>
        History: {history ? Object.entries(history.counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none' : '…'}
        {history?.syncedAt && ` · last PayPal sync ${new Date(history.syncedAt).toLocaleString()}`}{' '}
        <button disabled={busy} onClick={syncHistory}>Sync history from PayPal</button>
      </p>
      {syncInfo && <p>{syncInfo}</p>}

      {error && <p role="alert" style={{ whiteSpace: 'pre-line' }}>Error: {error}</p>}

      {!data && (
        <>
          <section>
            <h2>Your rules</h2>
            <textarea rows={6} cols={80} value={rules} placeholder="Write your payout rules in plain English, one per line"
              onChange={e => { setRules(e.target.value); setRulesSaved(false); }} />
            <br />
            <button disabled={busy || rulesSaved} onClick={saveRules}>{rulesSaved ? 'Saved' : 'Save rules'}</button>
          </section>

          <form onSubmit={e => { e.preventDefault(); upload(new FormData(e.currentTarget)); }}>
            <h2>New payout batch</h2>
            <label>Payout CSV <input name="csv" type="file" accept=".csv,text/csv" required disabled={busy} /></label>
            <br />
            <label>Invoices (PDF or text) <input name="invoices" type="file" accept=".pdf,.txt,application/pdf,text/plain" multiple disabled={busy} /></label>
            <br />
            <label>Related emails or notes (optional)<br />
              <textarea name="notes" rows={4} cols={80} placeholder="Paste emails or notes; leave a blank line between them" disabled={busy} />
            </label>
            <br />
            <button type="submit" disabled={busy}>{busy ? 'Reviewing…' : 'Review batch'}</button>{' '}
            {demo && (
              <>
                <button type="button" disabled={busy} onClick={() => { const f = new FormData(); f.set('demo', '1'); upload(f); }}>Load demo</button>{' '}
                <button type="button" disabled={busy} onClick={resetDemo}>Reset demo</button>
              </>
            )}
          </form>

          {recent.length > 0 && (
            <section>
              <h2>Recent batches</h2>
              <ul>
                {recent.map(b => (
                  <li key={b.id}>
                    <button onClick={() => openBatch(b.id)}>
                      {new Date(b.created_at).toLocaleString()} · {b.lines} lines · {b.status}
                      {b.unclaimed ? ` · ${b.unclaimed} unclaimed` : ''}{b.pending ? ` · ${b.pending} sending` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {data && (
        <>
          <p><button onClick={() => openBatch(null)}>New batch</button></p>
          <p>{data.batch.summary}</p>
          <p>Batch {data.batch.id} · {data.batch.status}</p>
          {data.payouts.length > 0 && (
            <ul>
              {data.payouts.map(p => (
                <li key={p.paypal_batch_id}>PayPal {p.paypal_batch_id} · {p.currency} · {p.status ?? 'checking…'}</li>
              ))}
            </ul>
          )}

          <table>
            <thead>
              <tr>
                <th>#</th><th>Name</th><th>Email</th><th>Amount</th><th>Invoice</th>
                <th>Verdict</th><th>Flags</th><th>Action</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map(l => {
                const flags = JSON.parse(l.flags) as Flag[];
                const fix = l.fix ? (JSON.parse(l.fix) as Fix) : null;
                const locked = sent || !!l.paypal_batch_id || !!l.send_ref;
                return (
                  <tr key={l.id} style={l.dropped ? { textDecoration: 'line-through' } : undefined}>
                    <td>{l.line}</td>
                    <td>{l.name}</td>
                    <td>{l.email}</td>
                    <td>{l.amount} {l.currency}</td>
                    <td>{l.invoice}</td>
                    <td>{l.verdict}</td>
                    <td>
                      <ul>
                        {flags.map((f, i) => (
                          <li key={i}><b>{f.type}</b>: {f.reason} <small>({f.evidence})</small></li>
                        ))}
                      </ul>
                      {l.fix_note && <p>{l.fix_note}</p>}
                    </td>
                    <td>
                      {!locked && fix && !l.fix_applied && (
                        <button disabled={busy} onClick={() => act(l.id, 'fix')}>{fixLabel(fix)}</button>
                      )}
                      {l.fix_applied ? 'Fix applied' : null}
                      {!locked && l.verdict === 'block' && !l.fix_applied && !l.override_reason && (
                        <button disabled={busy} onClick={() => {
                          const reason = prompt('Why send this blocked line anyway?');
                          if (reason) act(l.id, 'override', reason);
                        }}>Override</button>
                      )}
                      {l.override_reason && <p>Overridden: {l.override_reason}</p>}
                      {l.verdict === 'review' && !l.dropped && (
                        <label>
                          <input type="checkbox" checked={!!l.ticked} disabled={busy || locked} onChange={() => act(l.id, 'tick')} /> Checked
                        </label>
                      )}
                    </td>
                    <td>
                      {isPending(l) ? 'Sending… waiting for PayPal' : l.status ?? '–'}
                      {l.error && l.status !== 'RETURNED' && <p><small>{l.error}</small></p>}
                      {(l.status === 'UNCLAIMED' || l.status === 'RETURNED') && !data.resent.includes(l.id) && (
                        <Unclaimed line={l} suggestion={data.suggestions[l.id] ?? null} nudgeHours={data.nudgeHours} busy={busy} onAct={unclaimed} />
                      )}
                      {data.resent.includes(l.id) && <p><small>Resent, see the line below</small></p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {pendingLines.length > 0 && (
            <p>
              {pendingLines.length} line(s) have no confirmation from PayPal yet. Retrying is safe: PayPal ignores a repeat of the same send.{' '}
              <button disabled={busy} onClick={send}>Retry</button>
            </p>
          )}
          {!sent && pendingLines.length === 0 && (
            <button disabled={busy || !data.canSend} onClick={send}>
              Approve batch and send via PayPal
            </button>
          )}
          {!sent && !data.canSend && <p>Resolve every block line (fix or override) and tick every review line to approve.</p>}
        </>
      )}
    </main>
  );
}

// Cancel or resend an unclaimed payout. Money never moves without a click and a confirm.
function Unclaimed({ line, suggestion, nudgeHours, busy, onAct }: {
  line: Line; suggestion: Suggestion; nudgeHours: number; busy: boolean;
  onAct: (lineId: number, action: 'cancel' | 'resend', email?: string) => void;
}) {
  const [email, setEmail] = useState(suggestion?.email ?? '');
  const hours = line.unclaimed_since ? (Date.now() - Date.parse(line.unclaimed_since)) / 36e5 : 0;
  const amount = `${line.amount} ${line.currency}`;
  return (
    <div>
      {line.status === 'UNCLAIMED' && hours >= nudgeHours && (
        <p role="status">Still unclaimed after {hours < 1 ? `${Math.round(hours * 60)} min` : `${Math.round(hours)} h`}</p>
      )}
      {line.status === 'UNCLAIMED' && (
        <button disabled={busy} onClick={() => confirm(`Cancel ${amount} to ${line.email}? The money returns to your balance.`) && onAct(line.id, 'cancel')}>
          Cancel payout
        </button>
      )}
      <label>
        Resend to <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="correct email" />
      </label>
      {suggestion && <small> Suggested from {suggestion.source}</small>}
      <button
        disabled={busy || !email.trim()}
        onClick={() => confirm(`${line.status === 'UNCLAIMED' ? 'Cancel this payout and send' : 'Send'} ${amount} to ${email.trim()}?`) && onAct(line.id, 'resend', email)}
      >
        {line.status === 'UNCLAIMED' ? 'Cancel and resend' : 'Resend'}
      </button>
    </div>
  );
}
