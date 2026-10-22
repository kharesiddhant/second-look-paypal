// Batches over 50 lines are reviewed in 50-line chunks, in parallel, in the background.
// With RENDER_WORKFLOW_SLUG set, each chunk is a Render Workflows task run (workflows/review.ts) with retries;
// without it (local development) the chunks run in this process. Both paths store results the same way.
import { Render } from '@renderinc/sdk';
import { db, getLines, loadHistory, type Batch } from './db';
import { lineContexts, type LineContext } from './facts';
import { guardLine } from './guards';
import { cachedReview, reviewInput, storeReview, toReview, type LineReview, type Review } from './review';
import { callReviewModel, type ModelReview } from './review-model';
import type { Table } from './csv';

export const CHUNK = 50;
const STUCK_MS = 15 * 60_000; // a chunk with no answer after 15 minutes counts as failed
const WORKFLOW = process.env.RENDER_WORKFLOW_SLUG;
let render: Render | null = null;

type Chunk = {
  batch_id: string; idx: number; key: string; run_id: string | null;
  status: 'running' | 'done' | 'failed'; result: string | null; error: string | null; started_at: string;
};

const chunks = (batchId: string) =>
  db().prepare('SELECT * FROM review_chunks WHERE batch_id = ? ORDER BY idx').all(batchId) as Chunk[];

function finish(batchId: string, idx: number, review: Review) {
  const c = db().prepare('SELECT key FROM review_chunks WHERE batch_id = ? AND idx = ?').get(batchId, idx) as { key: string } | undefined;
  db().prepare("UPDATE review_chunks SET status = 'done', result = ? WHERE batch_id = ? AND idx = ?").run(JSON.stringify(review), batchId, idx);
  if (c) storeReview(c.key, review);
}

function fail(batchId: string, idx: number, error: string) {
  console.error('review chunk failed', batchId, idx, error);
  db().prepare("UPDATE review_chunks SET status = 'failed', error = ? WHERE batch_id = ? AND idx = ?").run(error, batchId, idx);
}

export async function startChunkedReview(batchId: string, contexts: LineContext[], notes: string[], rules: string) {
  const insert = db().prepare('INSERT INTO review_chunks (batch_id, idx, key, status, started_at) VALUES (?, ?, ?, ?, ?)');
  for (let idx = 0; idx * CHUNK < contexts.length; idx++) {
    const part = contexts.slice(idx * CHUNK, (idx + 1) * CHUNK);
    const { system, content, key } = reviewInput(part, contexts, notes, rules);
    insert.run(batchId, idx, key, 'running', new Date().toISOString());
    const cached = cachedReview(key);
    if (cached) { finish(batchId, idx, cached); continue; }
    if (!WORKFLOW) {
      // Local: runs in this process; the page picks the result up on its next refresh.
      callReviewModel(system, content).then(out => finish(batchId, idx, toReview(out)), e => fail(batchId, idx, (e as Error).message));
      continue;
    }
    try {
      render ??= new Render();
      // The idempotency key makes a repeated start return the same run instead of reviewing the chunk twice.
      const run = await render.workflows.startTask(`${WORKFLOW}/reviewChunk`, [system, content], { idempotencyKey: `${batchId}-${idx}` });
      db().prepare('UPDATE review_chunks SET run_id = ? WHERE batch_id = ? AND idx = ?').run(run.taskRunId, batchId, idx);
    } catch (e) {
      fail(batchId, idx, `could not start: ${(e as Error).message}`);
    }
  }
}

// Called while a batch is reviewing (on each page refresh): collects finished runs, then finalises once.
export async function refreshChunkedReview(batch: Batch) {
  for (const c of chunks(batch.id).filter(c => c.status === 'running')) {
    if (c.run_id) {
      try {
        render ??= new Render();
        const run = await render.workflows.getTaskRun(c.run_id);
        if (run.status === 'completed' || run.status === 'succeeded') finish(batch.id, c.idx, toReview(run.results[0] as ModelReview));
        else if (run.status === 'failed' || run.status === 'canceled') fail(batch.id, c.idx, run.error ?? run.status);
      } catch (e) {
        console.error('chunk poll failed', c.run_id, (e as Error).message);
      }
    }
    if (Date.now() - Date.parse(c.started_at) > STUCK_MS) fail(batch.id, c.idx, 'no answer after 15 minutes');
  }
  const now = chunks(batch.id);
  const done = now.filter(c => c.status !== 'running').length;
  if (done === now.length && batch.status === 'reviewing') finalize(batch, now);
  return { done, total: now.length };
}

// All chunks answered: apply the code floor and fix checks to every line and open the batch for approval.
function finalize(batch: Batch, parts: Chunk[]) {
  const lines = getLines(batch.id).filter(l => !l.resend_of);
  const table: Table = {
    rows: lines.map(l => ({ name: l.name, email: l.email, amount: l.amount, currency: l.currency, invoice: l.invoice, note: l.note })),
    raw: lines.map(l => [l.name, l.email, l.amount, l.currency, l.invoice, l.note].join(',')),
  };
  const contexts = lineContexts(table, loadHistory(), JSON.parse(batch.invoices ?? '[]'), JSON.parse(batch.notes ?? '[]'));

  const byLine = new Map<number, LineReview>();
  const failedLines = new Set<number>();
  for (const p of parts) {
    if (p.status === 'done' && p.result) for (const l of (JSON.parse(p.result) as Review).lines) byLine.set(l.line, l);
    else for (let n = p.idx * CHUNK + 1; n <= (p.idx + 1) * CHUNK; n++) failedLines.add(n);
  }

  const update = db().prepare('UPDATE lines SET verdict = ?, flags = ?, fix = ?, fix_note = ? WHERE batch_id = ? AND line = ? AND resend_of IS NULL');
  const counts = { block: 0, review: 0, ok: 0 };
  for (const c of contexts) {
    // Owner's rule: a line the AI did not answer is never ok; it needs the owner's tick.
    const reason = failedLines.has(c.line) ? 'AI review unavailable. Check this line yourself.' : 'The review returned nothing for this line.';
    const ai: LineReview = byLine.get(c.line) ?? { line: c.line, verdict: 'review', flags: [{ type: 'unreviewed', reason, evidence: '' }], fix: null, fix_note: null };
    const rv = guardLine(ai, c);
    counts[rv.verdict]++;
    update.run(rv.verdict, JSON.stringify(rv.flags), rv.fix ? JSON.stringify(rv.fix) : null, rv.fix_note, batch.id, c.line);
  }
  const failed = parts.filter(p => p.status === 'failed').length;
  const summary = `${contexts.length} lines reviewed in ${parts.length} parts: ${counts.block} block, ${counts.review} review, ${counts.ok} ok.`
    + (failed ? ` ${failed} part(s) had no AI answer; their lines need your check.` : '');
  db().prepare("UPDATE batches SET status = 'review', summary = ? WHERE id = ?").run(summary, batch.id);
}
