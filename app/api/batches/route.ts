import { readFileSync } from 'node:fs';
import { db, demoMode, getRules, loadHistory } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import { parseCsvTable, validatePayoutRows, type Table } from '@/lib/csv';
import { lineContexts, parseInvoices, splitNotes, type Invoice } from '@/lib/facts';
import { guardLine } from '@/lib/guards';
import { readInvoiceFile } from '@/lib/invoices';
import { reviewBatch, type LineReview, type Review } from '@/lib/review';
import { CHUNK, startChunkedReview } from '@/lib/chunks';

const MAX_FILES = 50;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024; // whole upload; everything is held in memory while it is read
const MAX_NOTES = 20_000;

// Recent batches, so a batch can be reopened after the page is closed (cancel and resend happen days later).
export async function GET(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const batches = db().prepare(`SELECT b.id, b.created_at, b.status, COUNT(l.id) AS lines,
      SUM(l.status = 'UNCLAIMED') AS unclaimed,
      SUM(l.dropped = 0 AND l.send_ref IS NOT NULL AND l.paypal_batch_id IS NULL) AS pending
    FROM batches b LEFT JOIN lines l ON l.batch_id = b.id
    GROUP BY b.id ORDER BY b.created_at DESC LIMIT 20`).all();
  return Response.json({ batches });
}

// Upload a batch: payout CSV, invoice files and pasted notes (or the demo files), then run the review.
export async function POST(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  if (Number(req.headers.get('content-length') ?? 0) > MAX_TOTAL + 1024 * 1024) {
    return Response.json({ error: 'The upload is over 20 MB in total' }, { status: 413 });
  }
  const form = await req.formData();
  let csv: string, notes: string[] = [];
  let files: File[] = [];
  let invoices: Invoice[] = [];

  if (form.get('demo')) {
    if (!demoMode()) return Response.json({ error: 'Demo files are off on this server' }, { status: 400 });
    const big = form.get('demo') === 'big'; // 500-line demo, reviewed in chunks
    csv = readFileSync(big ? 'day1-test/big-payout.csv' : 'day1-test/payout.csv', 'utf8');
    ({ invoices, notes } = parseInvoices(readFileSync(big ? 'day1-test/big-invoices.txt' : 'day1-test/invoices.txt', 'utf8')));
  } else {
    const csvFile = form.get('csv');
    if (!(csvFile instanceof File)) return Response.json({ error: 'Choose a payout CSV' }, { status: 400 });
    files = form.getAll('invoices').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > MAX_FILES) return Response.json({ error: `At most ${MAX_FILES} invoice files` }, { status: 400 });
    const tooBig = files.find(f => f.size > MAX_FILE);
    if (tooBig) return Response.json({ error: `${tooBig.name} is over 5 MB` }, { status: 400 });
    if (csvFile.size + files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL) {
      return Response.json({ error: 'The upload is over 20 MB in total' }, { status: 413 });
    }
    const notesText = String(form.get('notes') ?? '');
    if (notesText.length > MAX_NOTES) return Response.json({ error: 'Notes are limited to 20,000 characters' }, { status: 400 });
    csv = await csvFile.text();
    notes = splitNotes(notesText);
  }

  // Owner's rule: any invalid row rejects the whole upload, before any AI cost.
  const parsed = parseCsvTable(csv);
  const problems = validatePayoutRows(parsed.rows);
  if (problems.length) {
    const more = problems.length > 20 ? `\n…and ${problems.length - 20} more` : '';
    return Response.json({ error: `The CSV needs fixing:\n${problems.slice(0, 20).join('\n')}${more}` }, { status: 400 });
  }
  const table: Table = { ...parsed, rows: parsed.rows.map(r => ({ ...r, currency: r.currency.toUpperCase() })) };

  // Read invoice files in parallel; a file that fails is named in the summary and its lines show a missing invoice.
  const unreadable: string[] = [];
  const results = await Promise.allSettled(files.map(readInvoiceFile));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { invoices.push(...r.value.invoices); notes.push(...r.value.notes); }
    else { unreadable.push(files[i].name); console.error('invoice read failed', files[i].name, r.reason); }
  });

  const history = loadHistory();
  const contexts = lineContexts(table, history, invoices, notes);
  const id = `sl-${Date.now()}`;
  const big = contexts.length > CHUNK;
  const insertLine = db().prepare(`INSERT INTO lines
    (batch_id, line, name, email, amount, currency, invoice, note, verdict, flags, fix, fix_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const saveBatch = (status: string, summary: string) => db().prepare(
    'INSERT INTO batches (id, created_at, status, summary, invoices, notes) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, new Date().toISOString(), status, summary, JSON.stringify(invoices), JSON.stringify(notes));
  const readNote = unreadable.length ? `Could not read: ${unreadable.join(', ')}. ` : '';

  if (big) {
    // Big batch: saved at once and reviewed in 50-line chunks in the background; the page shows progress.
    saveBatch('reviewing', `${readNote}Reviewing ${contexts.length} lines in ${Math.ceil(contexts.length / CHUNK)} parts…`);
    const pending = JSON.stringify([{ type: 'reviewing', reason: 'AI review in progress', evidence: '' }]);
    for (const c of contexts) {
      const r = c.row;
      insertLine.run(id, c.line, r.name, r.email, r.amount, r.currency, r.invoice, r.note ?? '', 'review', pending, null, null);
    }
    await startChunkedReview(id, contexts, notes, getRules());
    return Response.json({ id });
  }

  // Owner's rule: if the AI fails, the batch still loads and every line needs a tick.
  let review: Review;
  let unreviewed = 'The review returned nothing for this line.';
  try {
    review = await reviewBatch(table, contexts, notes, getRules());
  } catch (e) {
    console.error('review failed', e);
    unreviewed = 'AI review unavailable. Check this line yourself.';
    review = { lines: [], summary: `AI review unavailable: ${(e as Error).message}` };
  }
  const byLine = new Map(review.lines.map(r => [r.line, r]));
  saveBatch('review', readNote + review.summary);
  for (const c of contexts) {
    const r = c.row;
    // A line the review missed is never auto-ok; code checks then apply on top of whatever the AI said.
    const ai: LineReview = byLine.get(c.line)
      ?? { line: c.line, verdict: 'review', flags: [{ type: 'unreviewed', reason: unreviewed, evidence: '' }], fix: null, fix_note: null };
    const rv = guardLine(ai, c);
    insertLine.run(id, c.line, r.name, r.email, r.amount, r.currency, r.invoice, r.note ?? '',
      rv.verdict, JSON.stringify(rv.flags), rv.fix ? JSON.stringify(rv.fix) : null, rv.fix_note);
  }
  return Response.json({ id });
}
