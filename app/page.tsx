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

const FINAL = ['SUCCESS', 'DENIED', 'CANCELED'];

const fixLabel = (f: Fix) =>
  f.action === 'drop' ? 'Drop line' : `Set ${f.changes.map(c => `${c.field} to ${c.value}`).join(', ')}`;

export default function Page() {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(batchId = id) {
    if (!batchId) return;
    const res = await fetch(`/api/batches/${batchId}`);
    setData(await res.json());
  }

  async function call(url: string, body?: unknown, raw?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: 'POST', body: raw ?? JSON.stringify(body ?? {}) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      return j;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    const j = await call('/api/batches', undefined, await file.text());
    if (j) { setId(j.id); load(j.id); }
  }

  async function act(lineId: number, action: string, reason?: string) {
    if (await call(`/api/lines/${lineId}`, { action, reason })) load();
  }

  async function unclaimed(lineId: number, action: 'cancel' | 'resend', email?: string) {
    if (await call(`/api/lines/${lineId}/unclaimed`, { action, email })) load();
  }

  async function send() {
    if (await call(`/api/batches/${id}/send`)) load();
  }

  // Polling: refresh every 5 s while any PayPal batch is not final.
  const sent = data?.batch.status === 'sent';
  const pending = !!data?.payouts.some(p => !FINAL.includes(p.status ?? ''));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => load(), 5000);
    return () => clearInterval(t);
  }, [pending, id]);

  return (
    <main>
      <h1>Second Look</h1>

      {!data && (
        <label>
          Upload payout CSV{' '}
          <input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      )}

      {error && <p role="alert">Error: {error}</p>}

      {data && (
        <>
          <p>{data.batch.summary}</p>
          <p>Batch {data.batch.id} · {data.batch.status}</p>
          {data.payouts.length > 0 && (
            <ul>
              {data.payouts.map(p => (
                <li key={p.paypal_batch_id}>PayPal {p.paypal_batch_id} · {p.currency} · {p.status}</li>
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
                const locked = sent || !!l.paypal_batch_id;
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
                      {l.status ?? '–'}
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

          {!sent && (
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
