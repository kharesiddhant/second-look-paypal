// Code computes exact facts per payout line so the model judges instead of searching raw files.
// Facts only: nothing here decides a verdict.
import { parseCsv } from './csv';

type Row = Record<string, string>;
type Invoice = { id: string; from: string; payTo: string; amount: string; currency: string };

// OD-09, od 09, od_09 all become OD09.
const norm = (id: string) => id.toUpperCase().replace(/[\s_-]/g, '');
const lc = (s: string) => s.trim().toLowerCase();

// ponytail: parses the day1-test invoices.txt text format; real PDF invoices need an extraction step first.
function parseInvoices(text: string) {
  const invoices = new Map<string, Invoice>();
  const notes: string[] = [];
  for (const chunk of text.split(/\n(?==== )|\n\s*\n/)) {
    const head = chunk.match(/^=== (.+?) ===/);
    if (!head) {
      if (chunk.trim()) notes.push(chunk.trim());
      continue;
    }
    const total = chunk.match(/Total ([\d.]+) ([A-Z]{3})/);
    invoices.set(norm(head[1]), {
      id: head[1],
      from: chunk.match(/From: (.+?) ·/)?.[1] ?? '',
      payTo: chunk.match(/Pay to PayPal: (\S+)/)?.[1] ?? '',
      amount: total?.[1] ?? '',
      currency: total?.[2] ?? '',
    });
  }
  return { invoices, notes };
}

// Corrected email for a resend: the invoice pay-to, else the most used past email, if it differs from what was sent.
export function suggestEmail(line: { name: string; email: string; invoice: string }, history: Row[], invoicesText: string) {
  const inv = parseInvoices(invoicesText).invoices.get(norm(line.invoice));
  if (inv?.payTo && lc(inv.payTo) !== lc(line.email)) return { email: inv.payTo, source: `invoice ${inv.id}` };
  const counts = new Map<string, number>();
  for (const h of history.filter(h => lc(h.name) === lc(line.name))) counts.set(h.email, (counts.get(h.email) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top && lc(top) !== lc(line.email)) return { email: top, source: 'past payouts' };
  return null;
}

export function buildFacts(csv: string, history: Row[], invoicesText: string) {
  const rawLines = csv.trim().split(/\r?\n/).slice(1).filter(l => l.trim());
  const rows = parseCsv(csv);
  const { invoices, notes } = parseInvoices(invoicesText);
  const paid = new Map(history.map(h => [norm(h.invoice), h]));

  // Compact on purpose: only differences and non-empty facts are printed.
  return rows.map((r, i) => {
    const out = [`line ${r.line}: ${rawLines[i]}`];

    const inv = invoices.get(norm(r.invoice));
    if (!inv) {
      out.push(`  invoice ${r.invoice}: not found`);
    } else {
      const diffs = [
        Number(r.amount) !== Number(inv.amount) && `amount ${r.amount} vs ${inv.amount}`,
        r.currency !== inv.currency && `currency ${r.currency} vs ${inv.currency}`,
        lc(r.email) !== lc(inv.payTo) && `email vs pay-to ${inv.payTo}`,
      ].filter(Boolean);
      out.push(`  invoice ${inv.id}: ${diffs.length ? diffs.join('; ') : 'amount, currency, email match'}`);
    }

    const past = history.filter(h => lc(h.name) === lc(r.name) || lc(h.email) === lc(r.email));
    if (!past.length) {
      out.push('  history: none (first-time)');
    } else {
      const count = (key: (h: Row) => string) => {
        const m = new Map<string, number>();
        for (const h of past) m.set(key(h), (m.get(key(h)) ?? 0) + 1);
        return [...m].map(([k, n]) => `${k} x${n}`).join(', ');
      };
      const sameEmail = past.every(h => lc(h.email) === lc(r.email));
      const last = past[past.length - 1];
      out.push(`  history: ${count(h => `${h.amount} ${h.currency}`)}; email ${sameEmail ? 'same' : count(h => h.email)}; last ${last.invoice} ${last.date}`);
    }

    const before = paid.get(norm(r.invoice));
    if (before) out.push(`  duplicate: ${before.invoice} already paid ${before.date}`);
    const sameInvoice = rows.filter((o, j) => j !== i && norm(o.invoice) === norm(r.invoice)).map(o => o.line);
    if (sameInvoice.length) out.push(`  duplicate: same invoice on line ${sameInvoice.join(', ')}`);

    const same = rows.filter((o, j) => j !== i && (lc(o.name) === lc(r.name) || lc(o.email) === lc(r.email))).map(o => o.line);
    if (same.length) out.push(`  same recipient: line ${same.join(', ')}`);

    // Notes and emails that mention this recipient's name, email or invoice.
    const keys = [lc(r.name), lc(r.email), lc(r.invoice), lc(r.name.split(' ')[0])].filter(k => k.length > 2);
    const related = notes.filter(n => keys.some(k => lc(n).includes(k)));
    out.push(...related.map(n => `  note: ${n.replace(/\s*\n\s*/g, ' | ')}`));

    return out.join('\n');
  }).join('\n\n');
}
