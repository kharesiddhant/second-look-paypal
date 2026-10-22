import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { db } from './db';
import { formatFacts, formatNotes, type LineContext } from './facts';
import { parseCsvTable, type Table } from './csv';
import { callReviewModel, EFFORT, MODEL, type ModelReview } from './review-model';

export type Change = { field: 'email' | 'amount' | 'currency'; value: string };
export type Fix = { action: 'set'; changes: Change[] } | { action: 'drop' };
export type Flag = { type: string; reason: string; evidence: string };
export type LineReview = { line: number; verdict: 'ok' | 'review' | 'block'; flags: Flag[]; fix: Fix | null; fix_note: string | null };
export type Review = { lines: LineReview[]; summary: string };

// What the model sees for some lines: their facts, the notes that concern them, and the rules. Notes that no
// line in the whole batch mentions go to every request, so a general note is never lost when a batch is split.
export function reviewInput(lines: LineContext[], all: LineContext[], notes: string[], rules: string) {
  const mentioned = new Set(all.flatMap(c => c.notes));
  const ids = [...new Set([...lines.flatMap(c => c.notes), ...notes.map((_, k) => k + 1).filter(n => !mentioned.has(n))])].sort((a, b) => a - b);
  const system = readFileSync('lib/reviewer-prompt.md', 'utf8');
  const content = [
    `<lines>\n${formatFacts(lines)}\n</lines>`,
    ids.length ? `<notes>\n${formatNotes(notes, ids)}\n</notes>` : '',
    `<rules>\n${rules.trim() || '(no rules set)'}\n</rules>`,
  ].filter(Boolean).join('\n\n');
  // Same prompt, facts, notes, rules, model and effort: the stored review is reused.
  const key = createHash('sha256').update([MODEL, EFFORT, system, content].join('\0')).digest('hex');
  return { system, content, key };
}

export function cachedReview(key: string): Review | null {
  const row = db().prepare('SELECT review FROM reviews WHERE key = ?').get(key) as { review: string } | undefined;
  return row ? JSON.parse(row.review) : null;
}

export function storeReview(key: string, review: Review) {
  db().prepare('INSERT OR REPLACE INTO reviews VALUES (?, ?, ?)').run(key, JSON.stringify(review), new Date().toISOString());
}

// A line in both lists keeps its detailed (stricter) verdict; a line in neither falls back to review upstream.
export function toReview(out: ModelReview): Review {
  const flagged = new Set(out.lines.map(l => l.line));
  return {
    summary: out.summary,
    lines: [
      ...out.ok_lines.filter(n => !flagged.has(n))
        .map(n => ({ line: n, verdict: 'ok' as const, flags: [], fix: null, fix_note: null })),
      ...out.lines.map((l): LineReview => ({
        ...l,
        fix: l.fix?.action === 'drop' ? { action: 'drop' as const }
          : l.fix?.changes.length ? { action: 'set' as const, changes: l.fix.changes }
          : null,
      })),
    ],
  };
}

// Batches of up to 50 lines: one review call while the owner waits. Bigger batches go through lib/chunks.ts.
export async function reviewBatch(table: Table, contexts: LineContext[], notes: string[], rules: string): Promise<Review> {
  // Test mode: no AI call, and only for the demo CSV; any other file would inherit the demo's verdicts.
  if (process.env.REVIEW_MODE === 'stub') {
    const demo = parseCsvTable(readFileSync('day1-test/payout.csv', 'utf8'));
    if (JSON.stringify(demo.rows) !== JSON.stringify(table.rows)) throw new Error('test mode (REVIEW_MODE=stub) only covers the demo CSV');
    return JSON.parse(readFileSync('day1-test/review.json', 'utf8'));
  }
  const { system, content, key } = reviewInput(contexts, contexts, notes, rules);
  const cached = cachedReview(key);
  if (cached) {
    console.log('review reused from cache');
    return cached;
  }
  const review = toReview(await callReviewModel(system, content));
  storeReview(key, review);
  return review;
}
