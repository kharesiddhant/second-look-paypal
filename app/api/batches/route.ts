import { readFileSync } from 'node:fs';
import { db, demoMode } from '@/lib/db';
import { requireOwner } from '@/lib/auth';
import { parseCsvTable, validatePayoutRows, type Table } from '@/lib/csv';
import { parseInvoices, type Invoice } from '@/lib/facts';
import { createBatch, MAX_TOTAL, readInvoiceFiles, uploadParts } from '@/lib/batches';

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
    const parts = uploadParts(form, csvFile.size);
    if ('error' in parts) return Response.json({ error: parts.error }, { status: parts.status });
    ({ files, notes } = parts);
    csv = await csvFile.text();
  }

  // Owner's rule: any invalid row rejects the whole upload, before any AI cost.
  const parsed = parseCsvTable(csv);
  const problems = validatePayoutRows(parsed.rows);
  if (problems.length) {
    const more = problems.length > 20 ? `\n…and ${problems.length - 20} more` : '';
    return Response.json({ error: `The CSV needs fixing:\n${problems.slice(0, 20).join('\n')}${more}` }, { status: 400 });
  }
  const table: Table = { ...parsed, rows: parsed.rows.map(r => ({ ...r, currency: r.currency.toUpperCase() })) };
  const read = await readInvoiceFiles(files);
  const id = await createBatch(table, [...invoices, ...read.invoices], [...notes, ...read.notes], read.unreadable);
  return Response.json({ id });
}
