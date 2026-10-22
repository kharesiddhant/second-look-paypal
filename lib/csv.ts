// CSV reading for payout batches. Quoted fields may contain commas, doubled quotes ("") and line breaks.
// Header names are matched without regard to case or surrounding spaces.

export type Table = { rows: Record<string, string>[]; raw: string[] };

function records(text: string): string[][] {
  const out: string[][] = [];
  let field = '', record: string[] = [], quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      record.push(field); out.push(record); record = []; field = '';
    } else field += c;
  }
  if (field !== '' || record.length) { record.push(field); out.push(record); }
  return out.filter(r => r.some(f => f.trim()));
}

// Rows keyed by lower-cased header, values trimmed. `raw` keeps each row as written (untrimmed) for the reviewer.
export function parseCsvTable(text: string): Table {
  const [head, ...body] = records(text);
  if (!head) return { rows: [], raw: [] };
  const keys = head.map(k => k.trim().toLowerCase());
  return {
    rows: body.map(cells => Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? '').trim()]))),
    raw: body.map(cells => cells.join(',')),
  };
}

export const parseCsv = (text: string) => parseCsvTable(text).rows;

const REQUIRED = ['name', 'email', 'amount', 'currency', 'invoice'];
export const MAX_ROWS = 200; // one review call holds about this many lines (README: Scaling)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Owner's rule: a CSV with any invalid row is rejected as a whole, with every problem listed by row number.
export function validatePayoutRows(rows: Record<string, string>[]): string[] {
  if (!rows.length) return ['The CSV has no payout rows.'];
  const missing = REQUIRED.filter(k => !(k in rows[0]));
  if (missing.length) return [`Missing column(s): ${missing.join(', ')}. Needed: ${REQUIRED.join(', ')} (note is optional).`];
  if (rows.length > MAX_ROWS) return [`At most ${MAX_ROWS} rows per batch; this one has ${rows.length}. Split it into smaller batches.`];
  const problems: string[] = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (!r.name) problems.push(`Row ${n}: name is empty`);
    if (!EMAIL.test(r.email)) problems.push(`Row ${n}: email "${r.email}" is not a valid address`);
    if (!/^\d+(\.\d{1,2})?$/.test(r.amount) || Number(r.amount) <= 0) {
      problems.push(`Row ${n}: amount "${r.amount}" must be a positive number like 850.00`);
    }
    if (!/^[A-Za-z]{3}$/.test(r.currency)) problems.push(`Row ${n}: currency "${r.currency}" must be a 3-letter code like USD`);
  });
  return problems;
}
