import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { db } from './db';
import { buildFacts } from './facts';

export type Change = { field: 'email' | 'amount' | 'currency'; value: string };
export type Fix = { action: 'set'; changes: Change[] } | { action: 'drop' };
export type Flag = { type: string; reason: string; evidence: string };
export type LineReview = { line: number; verdict: 'ok' | 'review' | 'block'; flags: Flag[]; fix: Fix | null; fix_note: string | null };
export type Review = { lines: LineReview[]; summary: string };

const MODEL = 'claude-sonnet-5-5';
const EFFORT = 'medium'; // was high; compare quality on payout.csv and blind-payout.csv

// Clean lines come back as bare numbers in ok_lines; only flagged lines carry detail (saves output tokens).
const ReviewSchema = z.object({
  ok_lines: z.array(z.number().int()),
  lines: z.array(z.object({
    line: z.number().int(),
    verdict: z.enum(['review', 'block']),
    flags: z.array(z.object({ type: z.string(), reason: z.string(), evidence: z.string() })),
    fix: z.object({
      action: z.enum(['set', 'drop']),
      changes: z.array(z.object({ field: z.enum(['email', 'amount', 'currency']), value: z.string() })),
    }).nullable(),
    fix_note: z.string().nullable(),
  })),
  summary: z.string(),
});

// ponytail: inputs are the fixed day1-test files; rules and invoices move to owner uploads in the depth phase.
export async function reviewBatch(csv: string): Promise<Review> {
  // Test mode: no AI call. The saved review only matches day1-test/payout.csv.
  if (process.env.REVIEW_MODE === 'stub') return JSON.parse(readFileSync('day1-test/review.json', 'utf8'));

  const history = db().prepare('SELECT * FROM history ORDER BY date').all() as Record<string, string>[];
  const system = readFileSync('day1-test/reviewer-prompt.md', 'utf8');
  const content = [
    `<lines>\n${buildFacts(csv, history, readFileSync('day1-test/invoices.txt', 'utf8'))}\n</lines>`,
    `<rules>\n${readFileSync('day1-test/rules.txt', 'utf8')}\n</rules>`,
  ].join('\n\n');

  // Same CSV, prompt, history, invoices, rules, model and effort: reuse the stored review.
  const key = createHash('sha256').update([MODEL, EFFORT, system, content].join('\0')).digest('hex');
  const cached = db().prepare('SELECT review FROM reviews WHERE key = ?').get(key) as { review: string } | undefined;
  if (cached) {
    console.log('review reused from cache');
    return JSON.parse(cached.review);
  }

  // ponytail: one call, max_tokens 16000. Estimated ceiling ~100 flagged lines (~150 output tokens each)
  // plus thinking; past ~200-line batches, split into parallel chunks (README: Scaling).
  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: EFFORT, format: betaZodOutputFormat(ReviewSchema) },
    system,
    messages: [{ role: 'user', content }],
  });
  console.log(`review usage: model=${response.model} effort=${EFFORT} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);

  if (response.stop_reason === 'refusal') throw new Error('Model declined the review');
  if (response.stop_reason === 'max_tokens') throw new Error('Review was cut off');
  const out = response.parsed_output;
  if (!out) throw new Error('Review output did not match the schema');

  // A line in both lists keeps its detailed (stricter) verdict; a line in neither falls back to review upstream.
  const flagged = new Set(out.lines.map(l => l.line));
  const review: Review = {
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
  db().prepare('INSERT OR REPLACE INTO reviews VALUES (?, ?, ?)').run(key, JSON.stringify(review), new Date().toISOString());
  return review;
}
