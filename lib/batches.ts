// Creating a batch, shared by CSV uploads and agent drafts, so both get the same review, code floor and limits.
import { db, getRules, loadHistory } from './db';
import type { Table } from './csv';
import { lineContexts, splitNotes, type Invoice } from './facts';
import { guardLine } from './guards';
import { readInvoiceFile } from './invoices';
import { reviewBatch, type LineReview, type Review } from './review';
import { CHUNK, startChunkedReview } from './chunks';

const MAX_FILES = 50;
const MAX_FILE = 5 * 1024 * 1024;
export const MAX_TOTAL = 20 * 1024 * 1024; // whole upload; everything is held in memory while it is read
const MAX_NOTES = 20_000;

// Invoice files and pasted notes from an upload form, within the limits.
export function uploadParts(form: FormData, extraBytes = 0): { files: File[]; notes: string[] } | { error: string; status: number } {
  const files = form.getAll('invoices').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_FILES) return { error: `At most ${MAX_FILES} invoice files`, status: 400 };
  const tooBig = files.find(f => f.size > MAX_FILE);
  if (tooBig) return { error: `${tooBig.name} is over 5 MB`, status: 400 };
  if (extraBytes + files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL) return { error: 'The upload is over 20 MB in total', status: 413 };
  const notesText = String(form.get('notes') ?? '');
  if (notesText.length > MAX_NOTES) return { error: 'Notes are limited to 20,000 characters', status: 400 };
  return { files, notes: splitNotes(notesText) };
}

// Reads invoice files in parallel; a file that fails is reported by name, and its lines show a missing invoice.
export async function readInvoiceFiles(files: File[]) {
  const invoices: Invoice[] = [], notes: string[] = [], unreadable: string[] = [];
  const results = await Promise.allSettled(files.map(readInvoiceFile));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { invoices.push(...r.value.invoices); notes.push(...r.value.notes); }
    else { unreadable.push(files[i].name); console.error('invoice read failed', files[i].name, r.reason); }
  });
  return { invoices, notes, unreadable };
}

// Saves a validated table as a batch and reviews it: one call for up to 50 lines, background chunks above that.
export async function createBatch(table: Table, invoices: Invoice[], notes: string[], unreadable: string[] = [], prefix = '') {
  const contexts = lineContexts(table, loadHistory(), invoices, notes);
  const id = `sl-${Date.now()}`;
  const insertLine = db().prepare(`INSERT INTO lines
    (batch_id, line, name, email, amount, currency, invoice, note, verdict, flags, fix, fix_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const saveBatch = (status: string, summary: string) => db().prepare(
    'INSERT INTO batches (id, created_at, status, summary, invoices, notes) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, new Date().toISOString(), status, summary, JSON.stringify(invoices), JSON.stringify(notes));
  const lead = prefix + (unreadable.length ? `Could not read: ${unreadable.join(', ')}. ` : '');

  if (contexts.length > CHUNK) {
    // Big batch: saved at once and reviewed in 50-line chunks in the background; the page shows progress.
    saveBatch('reviewing', `${lead}Reviewing ${contexts.length} lines in ${Math.ceil(contexts.length / CHUNK)} parts…`);
    const pending = JSON.stringify([{ type: 'reviewing', reason: 'AI review in progress', evidence: '' }]);
    for (const c of contexts) {
      const r = c.row;
      insertLine.run(id, c.line, r.name, r.email, r.amount, r.currency, r.invoice, r.note ?? '', 'review', pending, null, null);
    }
    await startChunkedReview(id, contexts, notes, getRules());
    return id;
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
  // A line the review missed is never auto-ok; code checks then apply on top of whatever the AI said.
  const guarded = contexts.map(c => {
    const ai: LineReview = byLine.get(c.line)
      ?? { line: c.line, verdict: 'review', flags: [{ type: 'unreviewed', reason: unreviewed, evidence: '' }], fix: null, fix_note: null };
    return { c, ai, rv: guardLine(ai, c) };
  });
  const raised = guarded.filter(g => g.rv.verdict !== g.ai.verdict).map(g => g.c.line);
  // The AI writes its summary before the code checks run, so say when they changed a verdict.
  const codeNote = raised.length ? ` Code checks raised line${raised.length > 1 ? 's' : ''} ${raised.join(', ')} to block.` : '';
  saveBatch('review', lead + review.summary + codeNote);
  for (const { c, rv } of guarded) {
    const r = c.row;
    insertLine.run(id, c.line, r.name, r.email, r.amount, r.currency, r.invoice, r.note ?? '',
      rv.verdict, JSON.stringify(rv.flags), rv.fix ? JSON.stringify(rv.fix) : null, rv.fix_note);
  }
  return id;
}
