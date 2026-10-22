// Code computes exact facts per payout line so the model judges instead of searching raw files.
// Facts only: nothing here decides a verdict (the code floor lives in lib/guards.ts).
import type { Table } from './csv';
import type { HistoryRow } from './db';

type Row = Record<string, string>;
export type Invoice = { id: string; from: string; payTo: string; amount: string; currency: string };

// OD-09, od 09, od_09 all become OD09.
const norm = (id: string) => id.toUpperCase().replace(/[\s_-]/g, '');
const lc = (s?: string) => (s ?? '').trim().toLowerCase();
const isPaid = (h: HistoryRow) => h.state !== 'in_flight';
const sameMoney = (a: string, b: string) => Number(a) === Number(b);

// Splits pasted emails or notes into separate chunks (blank line between them).
export const splitNotes = (text: string) => text.split(/\n\s*\n/).map(n => n.trim()).filter(Boolean);
// Notes keep their batch-wide numbers (n1, n2…) even when only some are sent with a chunk of lines.
export const formatNotes = (notes: string[], ids = notes.map((_, k) => k + 1)) =>
  ids.map(n => `n${n}: ${notes[n - 1].replace(/\s*\n\s*/g, ' | ')}`).join('\n');

// Reads the demo text format ("=== ID ===" blocks plus free notes). Other files go through AI extraction (lib/invoices.ts).
export function parseInvoices(text: string) {
  const invoices: Invoice[] = [];
  const notes: string[] = [];
  for (const chunk of text.split(/\n(?==== )|\n\s*\n/)) {
    const head = chunk.match(/^=== (.+?) ===/);
    if (!head) {
      if (chunk.trim()) notes.push(chunk.trim());
      continue;
    }
    const total = chunk.match(/Total ([\d.]+) ([A-Z]{3})/);
    invoices.push({
      id: head[1],
      from: chunk.match(/From: (.+?) ·/)?.[1] ?? '',
      payTo: chunk.match(/Pay to PayPal: (\S+)/)?.[1] ?? '',
      amount: total?.[1] ?? '',
      currency: total?.[2] ?? '',
    });
  }
  return { invoices, notes };
}

// Invoices grouped by ID. Exact repeats (same total, currency and pay-to) collapse into one;
// anything else under the same ID is a conflict the reviewer must see.
function invoiceGroups(list: Invoice[]) {
  const groups = new Map<string, Invoice[]>();
  for (const inv of list) {
    const k = norm(inv.id);
    const g = groups.get(k) ?? [];
    if (!g.some(o => sameMoney(o.amount, inv.amount) && o.currency === inv.currency && lc(o.payTo) === lc(inv.payTo))) g.push(inv);
    groups.set(k, g);
  }
  return groups;
}

// Whole-word match for a first name ("raj" must not match "rajesh"); substring for full names, emails and IDs.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, key: string, word = false) =>
  word ? new RegExp(`\\b${escape(key)}\\b`, 'i').test(text) : lc(text).includes(key);

export type LineContext = {
  line: number; row: Row; raw: string;
  invoice?: Invoice;          // the line's invoice, when exactly one matches its ID
  conflict?: Invoice[];       // several different invoices share the line's invoice ID
  past: HistoryRow[];         // completed payouts to this recipient (same name or email)
  before?: HistoryRow;        // this invoice already paid, or a payout for it still in flight
  sameInvoice: number[]; sameRecipient: number[]; notes: number[];
};

// Line numbers are row positions (1, 2, 3...), never the CSV's own line column, so they are always unique.
export function lineContexts(table: Table, history: HistoryRow[], invoiceList: Invoice[], notes: string[] = []): LineContext[] {
  const { rows, raw } = table;
  const groups = invoiceGroups(invoiceList);
  const prior = new Map<string, HistoryRow>();
  for (const h of history) {
    if (!h.invoice) continue; // imported rows without an invoice ID can never match as duplicates
    const k = norm(h.invoice);
    if (!prior.has(k) || !isPaid(prior.get(k)!)) prior.set(k, h); // a completed payment outranks one in flight
  }
  return rows.map((r, i) => {
    const key = norm(r.invoice ?? '');
    const found = key ? groups.get(key) ?? [] : [];
    const others = (match: (o: Row) => boolean) => rows.flatMap((o, j) => (j !== i && match(o) ? [j + 1] : []));
    const keys = [lc(r.name), lc(r.email), key ? lc(r.invoice) : ''].filter(k => k.length > 2);
    const first = lc(r.name).split(/\s+/)[0];
    return {
      line: i + 1, row: r, raw: raw[i] ?? '',
      invoice: found.length === 1 ? found[0] : undefined,
      conflict: found.length > 1 ? found : undefined,
      past: history.filter(h => isPaid(h) && (lc(h.name) === lc(r.name) || lc(h.email) === lc(r.email))),
      before: key ? prior.get(key) : undefined,
      sameInvoice: key ? others(o => norm(o.invoice ?? '') === key) : [],
      sameRecipient: others(o => lc(o.name) === lc(r.name) || lc(o.email) === lc(r.email)),
      notes: notes.flatMap((n, k) => (keys.some(x => mentions(n, x)) || (first.length > 2 && mentions(n, first, true)) ? [k + 1] : [])),
    };
  });
}

// Corrected email for a resend: the invoice pay-to, else the most used past email, if it differs from what was sent.
export function suggestEmail(line: { name: string; email: string; invoice: string }, history: HistoryRow[], invoiceList: Invoice[]) {
  const found = invoiceGroups(invoiceList).get(norm(line.invoice ?? '')) ?? [];
  const inv = found.length === 1 ? found[0] : undefined;
  if (inv?.payTo && lc(inv.payTo) !== lc(line.email)) return { email: inv.payTo, source: `invoice ${inv.id}` };
  const counts = new Map<string, number>();
  for (const h of history.filter(h => isPaid(h) && lc(h.name) === lc(line.name))) counts.set(h.email, (counts.get(h.email) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top && lc(top) !== lc(line.email)) return { email: top, source: 'past payouts' };
  return null;
}

// Compact on purpose: only differences and non-empty facts are printed. Notes are listed once in <notes>
// and referenced here by ID, so a long email is not repeated under every line that mentions it.
export const buildFacts = (table: Table, history: HistoryRow[], invoiceList: Invoice[], notes: string[] = []) =>
  formatFacts(lineContexts(table, history, invoiceList, notes));

// Facts are computed over the whole batch first, so a chunk of lines still sees duplicates and repeats elsewhere.
export function formatFacts(contexts: LineContext[]) {
  return contexts.map(c => {
    const r = c.row;
    const out = [`line ${c.line}: ${c.raw}`];

    if (c.conflict) {
      out.push(`  invoice ${r.invoice}: ${c.conflict.length} different invoices share this ID: ${
        c.conflict.map(v => `${v.amount} ${v.currency} pay-to ${v.payTo || 'none'}`).join('; ')}`);
    } else if (!c.invoice) {
      out.push(`  invoice ${r.invoice || '(none)'}: not found`);
    } else {
      const inv = c.invoice;
      const diffs = [
        !sameMoney(r.amount, inv.amount) && `amount ${r.amount} vs ${inv.amount}`,
        r.currency !== inv.currency && `currency ${r.currency} vs ${inv.currency}`,
        lc(r.email) !== lc(inv.payTo) && `email vs pay-to ${inv.payTo || 'none'}`,
      ].filter(Boolean);
      out.push(`  invoice ${inv.id}: ${diffs.length ? diffs.join('; ') : 'amount, currency, email match'}`);
    }

    if (!c.past.length) {
      out.push('  history: none (first-time)');
    } else {
      const count = (key: (h: HistoryRow) => string) => {
        const m = new Map<string, number>();
        for (const h of c.past) m.set(key(h), (m.get(key(h)) ?? 0) + 1);
        return [...m].map(([k, n]) => `${k} x${n}`).join(', ');
      };
      const sameEmail = c.past.every(h => lc(h.email) === lc(r.email));
      const last = c.past[c.past.length - 1];
      out.push(`  history: ${count(h => `${h.amount} ${h.currency}`)}; email ${sameEmail ? 'same' : count(h => h.email)}; last ${
        [last.invoice, last.date].filter(Boolean).join(' ')}`);
    }

    if (c.before) {
      out.push(isPaid(c.before)
        ? `  duplicate: ${c.before.invoice} already paid ${c.before.date}`
        : `  duplicate: ${c.before.invoice} has a payout still in flight since ${c.before.date}`);
    }
    if (c.sameInvoice.length) out.push(`  duplicate: same invoice on line ${c.sameInvoice.join(', ')}`);
    if (c.sameRecipient.length) out.push(`  same recipient: line ${c.sameRecipient.join(', ')}`);
    if (c.notes.length) out.push(`  notes: ${c.notes.map(k => `n${k}`).join(', ')}`);
    return out.join('\n');
  }).join('\n\n');
}
